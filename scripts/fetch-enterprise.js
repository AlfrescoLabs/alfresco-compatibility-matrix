/**
 * Fetches docker-compose/compose.yaml from every stable tag of acs-deployment,
 * deduplicates to one entry per ACS minor version (highest tag wins),
 * and fills missing ACS 7.x entries from AlfrescoLabs/alfresco-enterprise-docker .env files.
 * Writes data/raw-enterprise.json.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { load as yamlLoad } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Maps Docker image name fragments → canonical component names
const IMAGE_MAP = [
  { match: /alfresco\/alfresco-content-repository:/,           name: 'repository' },
  { match: /alfresco\/alfresco-share:/,                        name: 'share' },
  { match: /alfresco\/alfresco-transform-router:/,             name: 'transformRouter' },
  { match: /alfresco\/alfresco-transform-core-aio:/,           name: 'transformCoreAio' },
  { match: /alfresco\/alfresco-shared-file-store:/,            name: 'sharedFileStore' },
  { match: /alfresco\/alfresco-digital-workspace:/,            name: 'digitalWorkspace' },
  { match: /alfresco\/alfresco-control-center:/,               name: 'controlCenter' },
  { match: /alfresco\/service-sync:/,                          name: 'serviceSync' },
  { match: /alfresco\/alfresco-activemq:/,                     name: 'activeMQ' },
  { match: /alfresco\/alfresco-elasticsearch-live-indexing:/,  name: 'elasticsearchIndexing' },
  { match: /alfresco\/alfresco-audit-storage:/,                name: 'auditStorage' },
  { match: /^postgres:/,                                       name: 'postgres' },
  // Plain Docker Hub official image (used from ACS 23.x onwards)
  { match: /^elasticsearch:/,                                  name: 'elasticsearch' },
  // Elastic registry (used in older ACS 7.x enterprise)
  { match: /docker\.elastic\.co\/elasticsearch\/elasticsearch:/, name: 'elasticsearch' },
  { match: /^opensearchproject\/opensearch:/,                  name: 'opensearch' },
  { match: /alfresco\/alfresco-search-services:/,              name: 'searchServices' },
];

// Maps .env keys from AlfrescoLabs/alfresco-enterprise-docker → canonical component names
const ENV_KEY_MAP = {
  ALFRESCO_TAG:        'repository',
  SHARE_TAG:           'share',
  SEARCH_TAG:          'search',
  TRANSFORM_ROUTER_TAG:'transformRouter',
  TRANSFORM_ENGINE_TAG:'transformCoreAio',
  SHARED_FILE_STORE_TAG:'sharedFileStore',
  ADW_TAG:             'digitalWorkspace',
  CONTROL_CENTER_TAG:  'controlCenter',
  SYNC_SERVICE_TAG:    'serviceSync',
  ACTIVEMQ_TAG:        'activeMQ',
  LIVE_INDEXING_TAG:   'elasticsearchIndexing',
  ELASTICSEARCH_TAG:   'elasticsearch',
  OPENSEARCH_TAG:      'opensearch',
  POSTGRES_TAG:        'postgres',
};

// quay.io image paths for enterprise Alfresco components (used for .env-based fallback entries)
const QUAY_IMAGE = {
  repository:           'quay.io/alfresco/alfresco-content-repository',
  share:                'quay.io/alfresco/alfresco-share',
  transformRouter:      'quay.io/alfresco/alfresco-transform-router',
  transformCoreAio:     'quay.io/alfresco/alfresco-transform-core-aio',
  sharedFileStore:      'quay.io/alfresco/alfresco-shared-file-store',
  digitalWorkspace:     'quay.io/alfresco/alfresco-digital-workspace',
  controlCenter:        'quay.io/alfresco/alfresco-control-center',
  serviceSync:          'quay.io/alfresco/service-sync',
  activeMQ:             'quay.io/alfresco/alfresco-activemq',
  elasticsearchIndexing:'quay.io/alfresco/alfresco-elasticsearch-live-indexing',
  auditStorage:         'quay.io/alfresco/alfresco-audit-storage',
};

// ACS minor versions covered by AlfrescoLabs repo (used as fallback for 7.x)
const ALFRESCOL_VERSIONS = ['7.1', '7.2', '7.3', '7.4'];
const ALFRESCOL_BASE = 'https://raw.githubusercontent.com/AlfrescoLabs/alfresco-enterprise-docker/main/generators/app/templates';

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

function extractTag(imageStr) {
  // Strip registry prefix (e.g. quay.io/alfresco/...) before looking for the colon
  const colonIdx = imageStr.lastIndexOf(':');
  return colonIdx !== -1 ? imageStr.slice(colonIdx + 1) : imageStr;
}

function extractComponents(doc) {
  const components = {};
  const services = doc?.services ?? {};

  for (const svc of Object.values(services)) {
    const image = svc?.image;
    if (!image || typeof image !== 'string') continue;

    // Strip registry prefix so regexes that start with ^ work on bare image names
    const bareImage = image.replace(/^[^/]+\.[^/]+\//, '');

    for (const { match, name } of IMAGE_MAP) {
      if (match.test(bareImage) || match.test(image)) {
        const colonIdx = image.lastIndexOf(':');
        const dockerImage = colonIdx !== -1 ? image.slice(0, colonIdx) : image;
        components[name] = { base: extractTag(image), dockerImage };
        if (name === 'elasticsearch') components[name].engine = 'elasticsearch';
        if (name === 'searchServices') components[name].engine = 'solr6';
        break;
      }
    }
  }

  // searchServices → search (Community Solr path)
  if (components.searchServices) {
    components.search = { ...components.searchServices, engine: 'solr6' };
    delete components.searchServices;
  }
  // elasticsearch stays as its own infrastructure component (not merged into search)

  return components;
}

function parseEnv(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const pb = b.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function acsMinor(acsVersion) {
  const parts = String(acsVersion).split('.');
  return `${parts[0]}.${parts[1]}`;
}

async function fetchStableTags() {
  const tags = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.github.com/repos/Alfresco/acs-deployment/tags?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) throw new Error(`GitHub tags API HTTP ${res.status}`);
    const batch = await res.json();
    if (batch.length === 0) break;
    for (const { name } of batch) {
      if (/^v\d+\.\d+\.\d+$/.test(name)) tags.push(name);
    }
    // Stop if this page was not full (no more pages)
    if (batch.length < 100) break;
  }
  return tags;
}

async function fetchComposeAtTag(tag) {
  const url = `https://raw.githubusercontent.com/Alfresco/acs-deployment/${tag}/docker-compose/compose.yaml`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  const cleaned = text.replace(/<%[^%]*%>/g, '""');
  return yamlLoad(cleaned);
}

async function fetchMasterNamedComposeFiles() {
  const url = 'https://api.github.com/repos/Alfresco/acs-deployment/contents/docker-compose';
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub contents API HTTP ${res.status}`);
  const entries = await res.json();
  const results = [];
  for (const entry of entries) {
    if (!/^\d+\.N-compose\.yaml$/.test(entry.name)) continue;
    const fileRes = await fetch(entry.download_url);
    if (!fileRes.ok) { console.warn(`  SKIP ${entry.name}: HTTP ${fileRes.status}`); continue; }
    const text = await fileRes.text();
    const cleaned = text.replace(/<%[^%]*%>/g, '""');
    results.push({ filename: entry.name, doc: yamlLoad(cleaned) });
  }
  return results;
}

async function fetchFallbackEnv(version) {
  const url = `${ALFRESCOL_BASE}/${version}/.env`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  SKIP fallback ${version}: HTTP ${res.status}`);
    return null;
  }
  return parseEnv(await res.text());
}

async function main() {
  console.log('Fetching stable tags from acs-deployment...');
  const tags = await fetchStableTags();
  console.log(`  Found ${tags.length} stable tags.`);

  // Sort descending so the highest (most recent) deployment tag per minor is encountered first
  tags.sort((a, b) => compareVersions(b, a));

  const resultByMinor = new Map();

  for (const tag of tags) {
    process.stdout.write(`  ${tag} ... `);
    let doc;
    try {
      doc = await fetchComposeAtTag(tag);
    } catch (err) {
      console.warn(`FAIL: ${err.message}`);
      continue;
    }
    if (!doc) {
      console.log('no compose.yaml, skipping');
      continue;
    }

    const components = extractComponents(doc);
    const acsVersion = components.repository?.base;
    if (!acsVersion) {
      console.log('no repository image found, skipping');
      continue;
    }

    const minor = acsMinor(acsVersion);
    if (resultByMinor.has(minor)) {
      console.log(`duplicate of ${minor}, skipping`);
      continue;
    }

    resultByMinor.set(minor, { acs: acsVersion, edition: 'enterprise', components });
    console.log(`OK → ACS ${acsVersion}`);
  }

  // Fill any minor versions missing from tags using named compose files on master
  console.log('\nFetching named compose files from master...');
  const namedFiles = await fetchMasterNamedComposeFiles();
  for (const { filename, doc } of namedFiles) {
    const components = extractComponents(doc);
    const acsVersion = components.repository?.base;
    if (!acsVersion) { console.log(`  ${filename}: no repository image, skipping`); continue; }
    const minor = acsMinor(acsVersion);
    if (resultByMinor.has(minor)) { console.log(`  ${filename}: ${minor} already covered, skipping`); continue; }
    resultByMinor.set(minor, { acs: acsVersion, edition: 'enterprise', components });
    console.log(`  ${filename}: OK → ACS ${acsVersion}`);
  }

  // Fallback: fill ACS 7.x entries from AlfrescoLabs repo (best-effort)
  console.log('\nFetching ACS 7.x fallback entries from AlfrescoLabs/alfresco-enterprise-docker...');
  for (const version of ALFRESCOL_VERSIONS) {
    if (resultByMinor.has(version)) {
      console.log(`  ${version} already present, skipping`);
      continue;
    }
    process.stdout.write(`  ${version} ... `);
    const env = await fetchFallbackEnv(version);
    if (!env) continue;

    const components = {};
    for (const [envKey, componentName] of Object.entries(ENV_KEY_MAP)) {
      if (env[envKey]) {
        const dockerImage = QUAY_IMAGE[componentName] ?? null;
        // For fallback entries base=latest (no patch history available)
        components[componentName] = { base: env[envKey], ...(dockerImage ? { dockerImage } : {}) };
      }
    }

    if (components.search) components.search.engine = 'solr6';

    const acsVersion = env['ALFRESCO_TAG'] ?? version;
    resultByMinor.set(version, { acs: acsVersion, edition: 'enterprise', components });
    console.log(`OK → ACS ${acsVersion}`);
  }

  // Elasticsearch / OpenSearch were not officially supported as search backends
  // in ACS 7.x Enterprise (Solr 6 was the only supported engine). Strip those
  // components from any pre-23.x entry so the matrix doesn't misrepresent them.
  for (const entry of resultByMinor.values()) {
    const major = parseInt(String(entry.acs).split('.')[0], 10);
    if (major < 23) {
      delete entry.components.elasticsearch;
      delete entry.components.elasticsearchIndexing;
      delete entry.components.opensearch;
      if (entry.components.search) entry.components.search.engine = 'solr6';
    }
  }

  const entries = [...resultByMinor.values()]
    .sort((a, b) => compareVersions(a.acs, b.acs));

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(
    join(ROOT, 'data', 'raw-enterprise.json'),
    JSON.stringify(entries, null, 2)
  );
  console.log(`\nDone. Wrote ${entries.length} enterprise entries.`);
}

main().catch(err => { console.error(err); process.exit(1); });
