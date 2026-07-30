/**
 * Fetches .env files from alfresco-docker-installer for all supported Community versions
 * and writes data/raw-community.json.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { load as yamlLoad } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BASE_URL = 'https://raw.githubusercontent.com/Alfresco/alfresco-docker-installer/master/generators/app/templates';
const CONTENTS_API = 'https://api.github.com/repos/Alfresco/alfresco-docker-installer/contents/generators/app/templates';

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function discoverVersions() {
  const res = await fetch(CONTENTS_API, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub Contents API HTTP ${res.status}`);
  const entries = await res.json();
  // Keep only directories whose name looks like an ACS version (e.g. 6.1, 23.4, 25.1)
  return entries
    .filter(e => e.type === 'dir' && /^\d+\.\d+$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      const [aMaj, aMin] = a.split('.').map(Number);
      const [bMaj, bMin] = b.split('.').map(Number);
      return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
    });
}

// Maps .env keys → canonical component names used in matrix.json
const KEY_MAP = {
  ALFRESCO_CE_TAG:      'repository',
  SEARCH_CE_TAG:        'search',
  SHARE_TAG:            'share',
  ACA_TAG:              'contentApp',
  POSTGRES_TAG:         'postgres',
  MARIADB_TAG:          'mariadb',
  TRANSFORM_ENGINE_TAG: 'transformEngine',
  ACTIVEMQ_TAG:         'activeMQ',
};

// Maps Docker image name fragments in acs-deployment's community-compose.yaml
// (master) -> canonical component names. Used only for the current
// in-development train, which has no template folder yet.
const COMPOSE_IMAGE_MAP = [
  { match: /alfresco\/alfresco-content-repository-community:/,        name: 'repository' },
  { match: /alfresco\/alfresco-share:/,                              name: 'share' },
  { match: /alfresco\/alfresco-content-app:/,                        name: 'contentApp' },
  { match: /alfresco\/alfresco-transform-core-aio:/,                 name: 'transformEngine' },
  { match: /alfresco\/alfresco-control-center:/,                     name: 'controlCenter' },
  { match: /alfresco\/alfresco-activemq:/,                           name: 'activeMQ' },
  { match: /alfresco\/alfresco-elasticsearch-batch-indexing:/,       name: 'elasticsearchIndexing' },
  { match: /^postgres:/,                                             name: 'postgres' },
  { match: /^elasticsearch:/,                                        name: 'elasticsearch' },
];

function extractTag(imageStr) {
  const colonIdx = imageStr.lastIndexOf(':');
  return colonIdx !== -1 ? imageStr.slice(colonIdx + 1) : imageStr;
}

function extractComposeComponents(doc) {
  const components = {};
  const services = doc?.services ?? {};
  for (const svc of Object.values(services)) {
    const image = svc?.image;
    if (!image || typeof image !== 'string') continue;
    // Strip registry prefix so regexes that start with ^ work on bare names
    const bareImage = image.replace(/^[^/]+\.[^/]+\//, '');
    for (const { match, name } of COMPOSE_IMAGE_MAP) {
      if (match.test(bareImage) || match.test(image)) {
        // Keep an explicit dockerImage only for registries resolve-latest.js
        // does not map itself (quay.io). Docker Hub images are resolved via its
        // own DOCKER_IMAGE table, so a bare { base } is enough there.
        const comp = { base: extractTag(image) };
        if (/^quay\.io\//.test(image)) {
          const colonIdx = image.lastIndexOf(':');
          comp.dockerImage = colonIdx !== -1 ? image.slice(0, colonIdx) : image;
        }
        if (name === 'elasticsearch') comp.engine = 'elasticsearch';
        components[name] = comp;
        break;
      }
    }
  }
  return components;
}

function parseEnv(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    // Skip template variables like <%=serverName%>
    if (!val.includes('<%')) result[key] = val;
  }
  return result;
}

async function fetchEnv(version) {
  const url = `${BASE_URL}/${version}/.env`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  SKIP ${version}: HTTP ${res.status}`);
    return null;
  }
  return parseEnv(await res.text());
}

async function main() {
  console.log('Discovering Community versions from alfresco-docker-installer...');
  const VERSIONS = await discoverVersions();
  console.log(`  Found versions: ${VERSIONS.join(', ')}`);

  const entries = [];

  for (const version of VERSIONS) {
    process.stdout.write(`  ${version} ... `);
    const env = await fetchEnv(version);
    if (!env) continue;

    const components = {};
    for (const [envKey, componentName] of Object.entries(KEY_MAP)) {
      if (env[envKey]) {
        components[componentName] = { base: env[envKey] };
      }
    }

    // Determine search engine from available keys
    if (components.search) {
      // Community always uses Solr for these versions
      components.search.engine = 'solr6';
    }

    entries.push({ acs: version, edition: 'community', components });
    console.log('OK');
  }

  // Fill the current in-development train (e.g. 26.2) from the plain master
  // community-compose.yaml in acs-deployment. The newest ACS version has no
  // template folder in alfresco-docker-installer until it is released, so it
  // would otherwise be invisible on the Community side.
  console.log('Fetching plain master community-compose.yaml...');
  const composeUrl = 'https://raw.githubusercontent.com/Alfresco/acs-deployment/master/docker-compose/community-compose.yaml';
  const composeRes = await fetch(composeUrl);
  if (!composeRes.ok) {
    console.warn(`  SKIP community-compose.yaml: HTTP ${composeRes.status}`);
  } else {
    const cleaned = (await composeRes.text()).replace(/<%[^%]*%>/g, '""');
    const components = extractComposeComponents(yamlLoad(cleaned));
    const repoBase = components.repository?.base;
    if (!repoBase) {
      console.warn('  SKIP community-compose.yaml: no repository image');
    } else {
      const minor = repoBase.split('.').slice(0, 2).join('.');
      if (entries.some(e => e.acs === minor)) {
        console.log(`  community-compose.yaml: ${minor} already covered, skipping`);
      } else {
        entries.push({ acs: minor, edition: 'community', components });
        console.log(`  community-compose.yaml: OK -> ACS ${minor} (repo ${repoBase})`);
      }
    }
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(
    join(ROOT, 'data', 'raw-community.json'),
    JSON.stringify(entries, null, 2)
  );
  console.log(`Done. Wrote ${entries.length} community entries.`);
}

main().catch(err => { console.error(err); process.exit(1); });
