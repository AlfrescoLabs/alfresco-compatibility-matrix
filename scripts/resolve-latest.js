/**
 * For every image:tag in raw-community.json and raw-enterprise.json,
 * queries Docker Hub (public images) or quay.io (enterprise images) to find
 * the latest available patch in the same major.minor train, then merges
 * everything into data/matrix.json.
 *
 * quay.io credentials are read from:
 *   - env vars QUAY_USER + QUAY_PASSWORD  (CI / GitHub Actions)
 *   - docker-credential-osxkeychain       (local macOS)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Docker Hub namespace + image name for each canonical component
const DOCKER_IMAGE = {
  // Community
  repository:      { ns: 'alfresco', image: 'alfresco-content-repository-community' },
  share:           { ns: 'alfresco', image: 'alfresco-share' },
  contentApp:      { ns: 'alfresco', image: 'alfresco-content-app' },
  transformEngine: { ns: 'alfresco', image: 'alfresco-transform-core-aio' },
  search:          null, // handled separately — depends on engine
  postgres:        { ns: 'library', image: 'postgres' },
  mariadb:         { ns: 'library', image: 'mariadb' },
  activeMQ:        { ns: 'alfresco', image: 'alfresco-activemq' },
  elasticsearch:   { ns: 'library', image: 'elasticsearch' },
  opensearch:      { ns: 'opensearchproject', image: 'opensearch' },
  // Community search indexer from ACS 26.2 (Solr search-services was dropped).
  // Enterprise uses the quay.io live-indexing image, resolved via its own
  // dockerImage, so this Docker Hub entry only applies to Community.
  elasticsearchIndexing: { ns: 'alfresco', image: 'alfresco-elasticsearch-batch-indexing' },
};

const SEARCH_ENGINE_IMAGE = {
  solr6:           { ns: 'alfresco', image: 'alfresco-search-services' },
  elasticsearch:   { ns: 'docker.elastic.co/elasticsearch', image: 'elasticsearch' },
};

// Simple in-process cache
const cache = new Map();

// quay.io Bearer token cache: repoPath → token
const quayTokenCache = new Map();

// ---------------------------------------------------------------------------
// quay.io credentials
// ---------------------------------------------------------------------------

function quayCredentials() {
  // 1. Explicit env vars (CI)
  if (process.env.QUAY_USER && process.env.QUAY_PASSWORD) {
    return { user: process.env.QUAY_USER, password: process.env.QUAY_PASSWORD };
  }
  // 2. macOS keychain via docker credential helper
  try {
    const raw = execSync('printf quay.io | docker-credential-osxkeychain get', { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
    const j = JSON.parse(raw);
    if (j.Username && j.Secret) return { user: j.Username, password: j.Secret };
  } catch { /* not available */ }
  return null;
}

const QUAY_CREDS = quayCredentials();
if (QUAY_CREDS) {
  console.log(`  quay.io credentials found for user: ${QUAY_CREDS.user}`);
} else {
  console.warn('  No quay.io credentials found — enterprise quay.io images will not be resolved.');
}

async function quayBearerToken(repoPath) {
  if (quayTokenCache.has(repoPath)) return quayTokenCache.get(repoPath);
  if (!QUAY_CREDS) return null;

  const authUrl = `https://quay.io/v2/auth?service=quay.io&scope=repository:${repoPath}:pull`;
  const basicAuth = Buffer.from(`${QUAY_CREDS.user}:${QUAY_CREDS.password}`).toString('base64');
  try {
    const res = await fetch(authUrl, { headers: { Authorization: `Basic ${basicAuth}` } });
    if (!res.ok) return null;
    const { token } = await res.json();
    quayTokenCache.set(repoPath, token ?? null);
    return token ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// quay.io tag fetching (OCI v2 API, paginated via Link header)
// ---------------------------------------------------------------------------

async function fetchQuayTags(repoPath, prefix) {
  const cacheKey = `quay:${repoPath}@${prefix}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const token = await quayBearerToken(repoPath);
  if (!token) { cache.set(cacheKey, null); return null; }

  const allTags = [];
  let url = `https://quay.io/v2/${repoPath}/tags/list?n=100`;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const json = await res.json();
    allTags.push(...(json.tags ?? []));

    // Follow OCI pagination Link header
    const link = res.headers.get('link');
    if (link) {
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? `https://quay.io${m[1]}` : null;
    } else {
      url = null;
    }
  }

  // Keep only tags that start with the prefix and are stable (pure dotted numbers)
  const stable = allTags.filter(t => t.startsWith(prefix) && /^\d+(\.\d+)*$/.test(t));
  cache.set(cacheKey, stable);
  return stable;
}

// ---------------------------------------------------------------------------
// Docker Hub tag fetching
// ---------------------------------------------------------------------------

function isStable(tag) {
  const lower = tag.toLowerCase();
  return !lower.includes('alpha') &&
         !lower.includes('-a.') &&
         !lower.includes('-a') && // quay.io uses -A1, -A2 style
         !lower.includes('beta') &&
         !lower.includes('-b.') &&
         !lower.includes('-b') && // quay.io uses -B1, -B2 style
         !lower.includes('snapshot') &&
         !lower.includes('rc') &&
         !lower.includes('latest') &&
         !lower.includes('sha');
}

function versionPrefix(tag) {
  const plain = tag.split('-')[0];
  const parts = plain.split('.');
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return parts[0];
}

function tagSuffix(tag) {
  const dashIdx = tag.indexOf('-');
  return dashIdx !== -1 ? tag.slice(dashIdx) : '';
}

function compareVersions(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function fetchDockerHubTags(ns, image, prefix) {
  const cacheKey = `hub:${ns}/${image}@${prefix}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  if (ns.startsWith('docker.elastic.co')) { cache.set(cacheKey, null); return null; }

  const repoPath = ns === 'library' ? `library/${image}` : `${ns}/${image}`;
  const url = `https://hub.docker.com/v2/repositories/${repoPath}/tags?page_size=100&name=${encodeURIComponent(prefix)}`;

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) { cache.set(cacheKey, null); return null; }
    const json = await res.json();
    const tags = (json.results ?? []).map(t => t.name).filter(isStable);
    cache.set(cacheKey, tags);
    return tags;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tag resolution helpers
// ---------------------------------------------------------------------------

async function resolveViaDockerHub(ns, image, baseTag) {
  const prefix = versionPrefix(baseTag);
  const suffix = tagSuffix(baseTag);
  const tags = await fetchDockerHubTags(ns, image, prefix);
  if (!tags || tags.length === 0) return baseTag;
  const compatible = suffix
    ? tags.filter(t => t.endsWith(suffix))
    : tags.filter(t => /^\d+(\.\d+)*$/.test(t) && t.startsWith(prefix + '.'));
  if (compatible.length === 0) return baseTag;
  compatible.sort((a, b) => compareVersions(b, a));
  return compatible[0];
}

async function resolveViaQuay(dockerImage, baseTag) {
  // dockerImage is e.g. "quay.io/alfresco/alfresco-content-repository"
  const repoPath = dockerImage.replace('quay.io/', '');
  const prefix = versionPrefix(baseTag);
  const tags = await fetchQuayTags(repoPath, prefix);
  if (!tags || tags.length === 0) return baseTag;
  tags.sort((a, b) => compareVersions(b, a));
  return tags[0];
}

// ---------------------------------------------------------------------------
// Main component resolver
// ---------------------------------------------------------------------------

async function resolveComponent(componentName, componentData, edition) {
  if (!componentData?.base) return componentData;

  // Enterprise images live on quay.io — resolve there
  if (componentData.dockerImage?.startsWith('quay.io/')) {
    const latest = await resolveViaQuay(componentData.dockerImage, componentData.base);
    return { ...componentData, latest: latest ?? componentData.base };
  }

  let ns, image;

  if (componentName === 'search') {
    const def = SEARCH_ENGINE_IMAGE[componentData.engine];
    if (!def) return componentData;
    ns = def.ns; image = def.image;
  } else {
    const def = DOCKER_IMAGE[componentName];
    if (!def) return componentData;
    ns = def.ns; image = def.image;
  }

  const latest = await resolveViaDockerHub(ns, image, componentData.base);

  let dockerImage;
  if (ns === 'library') {
    dockerImage = image;
  } else {
    dockerImage = `${ns}/${image}`;
  }

  return { ...componentData, latest: latest ?? componentData.base, dockerImage };
}

// ---------------------------------------------------------------------------

async function main() {
  const communityRaw = JSON.parse(readFileSync(join(ROOT, 'data', 'raw-community.json'), 'utf8'));
  const enterpriseRaw = JSON.parse(readFileSync(join(ROOT, 'data', 'raw-enterprise.json'), 'utf8'));

  const allEntries = [...communityRaw, ...enterpriseRaw];
  const resolved = [];

  for (const entry of allEntries) {
    process.stdout.write(`  Resolving ${entry.edition} ${entry.acs} ... `);
    const components = {};
    for (const [name, data] of Object.entries(entry.components)) {
      components[name] = await resolveComponent(name, data, entry.edition);
    }
    resolved.push({ ...entry, components });
    console.log('OK');
  }

  const matrix = {
    generated: new Date().toISOString(),
    versions: resolved,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'matrix.json'), JSON.stringify(matrix, null, 2));
  console.log(`\nDone. matrix.json written with ${resolved.length} entries.`);
}

main().catch(err => { console.error(err); process.exit(1); });
