/**
 * Fetches .env files from alfresco-docker-installer for all supported Community versions
 * and writes data/raw-community.json.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(
    join(ROOT, 'data', 'raw-community.json'),
    JSON.stringify(entries, null, 2)
  );
  console.log(`Done. Wrote ${entries.length} community entries.`);
}

main().catch(err => { console.error(err); process.exit(1); });
