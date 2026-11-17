# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci            # install (only dependency: js-yaml)
npm run fetch     # fetch-community.js + fetch-enterprise.js -> data/raw-*.json
npm run resolve   # resolve-latest.js -> data/matrix.json
npm run build     # fetch + resolve
npm run serve     # preview at http://localhost:3000 (npx serve)
```

Each script can also run alone: `node scripts/<name>.js`. `resolve-latest.js` only reads the raw files, so it can be re-run without fetching again.

There is no test suite and no linter.

Environment:

- `GITHUB_TOKEN` (optional locally): used for GitHub API calls. Without it the unauthenticated limit is 60 requests/hour.
- `QUAY_USER` + `QUAY_PASSWORD`, or `docker login quay.io` on macOS (read via `docker-credential-osxkeychain`). Needed to resolve enterprise patches. Without credentials, quay.io components get `latest = base` and the script does not fail.

## Architecture

Static site plus a Node.js (ESM) data pipeline. No framework, no bundler.

### Pipeline (`scripts/`)

`fetch-community.js` -> `data/raw-community.json`:

1. Version folders in `Alfresco/alfresco-docker-installer` `generators/app/templates/` (GitHub Contents API). Reads each `.env` and maps keys with `KEY_MAP`. `search` is always `engine: solr6`.
2. `docker-compose/community-compose.yaml` from `acs-deployment` master, then every stable tag (first ref per minor wins), mapped with `COMPOSE_IMAGE_MAP`. A minor the installer does not cover yet (the in-development train) is added as a whole entry. For a minor the installer covers, only the missing `SEARCH_BACKEND_KEYS` are merged in.

`fetch-enterprise.js` -> `data/raw-enterprise.json`. One entry per ACS minor. The first source that covers a minor wins:

1. `docker-compose/compose.yaml` at each stable `vX.Y.Z` tag of `Alfresco/acs-deployment`. Tags are sorted descending, so the highest tag per minor wins.
2. `N.N-compose.yaml` files on `acs-deployment` master.
3. Plain `compose.yaml` on master (the in-development train).
4. `.env` files from `AlfrescoLabs/alfresco-enterprise-docker` for 7.1-7.4 (`ALFRESCOL_VERSIONS`), mapped with `ENV_KEY_MAP` and `QUAY_IMAGE`.

After that, entries with major < 23 lose `elasticsearch`, `elasticsearchIndexing` and `opensearch` (only Solr 6 was supported there). The `alfresco-search-services` image is renamed to the `search` component.

Both fetchers replace `<% ... %>` template placeholders with `""` before YAML parsing.

### Search backends

- Community up to 26.1 uses Solr (`search`, from `SEARCH_CE_TAG`). From 26.2, Solr is gone: search is `alfresco-elasticsearch-batch-indexing` (`elasticsearchIndexing`) plus Elasticsearch or OpenSearch. Enterprise 23.x+ uses `quay.io/.../alfresco-elasticsearch-live-indexing` under the same key.
- Wherever Elasticsearch is an option, OpenSearch is too (project rule). But OpenSearch versions come from upstream only. Today the only upstream source is `OPENSEARCH_TAG` in the installer `.env` (26.2 has the floating tag `2`). `acs-deployment` compose files only ship Elasticsearch, so Enterprise has no OpenSearch row.
- The installer 26.2 `.env` has OpenSearch and no Elasticsearch. `community-compose.yaml` has Elasticsearch and no OpenSearch. This is why both sources are merged for the same minor.
- The installer `.env` also has `JECI_SEARCH_TAG` (a community Solr 9 fork, used only with `--searchType=jeci`). It is intentionally not mapped.
- The `docs-alfresco` GitHub repo is stale for ACS 23+, and docs.hyland.com supported-platforms pages are not scrapable (JS navigation, about 480 KB). Neither is a usable source of version data.

`resolve-latest.js` -> `data/matrix.json`. For each component it finds the highest stable tag in the same `major.minor` train:

- If `dockerImage` starts with `quay.io/`: quay.io OCI v2 tag list (needs credentials).
- Otherwise: Docker Hub, using the `DOCKER_IMAGE` table (or `SEARCH_ENGINE_IMAGE` by `engine` for `search`). Images on `docker.elastic.co` are not resolved. A tag suffix like `-alpine` must match.
- Docker Hub is queried with one page of 100 tags filtered by name prefix.

### `matrix.json` schema

```json
{
  "generated": "<ISO timestamp>",
  "versions": [
    {
      "acs": "25.1",
      "edition": "community|enterprise",
      "components": {
        "<componentName>": {
          "base": "<tag from source>",
          "latest": "<highest stable patch found>",
          "dockerImage": "<image path>",
          "engine": "solr6|elasticsearch"
        }
      }
    }
  ]
}
```

Community `acs` is the minor (`25.1`). Enterprise `acs` is the full repository tag (`25.1.1`, `7.3.0.1`). `engine` is only set on search-related components.

### Frontend

`index.html` (inline IIFE script) + `style.css`. It fetches `data/matrix.json` at runtime. No build step. `CATEGORIES` sets grouping and order, `DISPLAY_NAMES` sets labels. A component key that is not listed in `CATEGORIES` is not shown. `elasticsearchIndexing` is labeled "Search", with Elasticsearch and OpenSearch badges. It never appears together with the Solr `search` key in the same entry.

### CI

`.github/workflows/refresh.yml` runs every Monday 06:00 UTC and on manual dispatch (Node 20). It runs the three scripts and deploys the whole repo directory to GitHub Pages. `node_modules`, `.claude` and `CLAUDE.md` are excluded from the artifact. CI does not commit the regenerated data back, so the `data/*.json` files in git can be older than the live site.

## Extension points

- New ACS versions need no code change. They are discovered from upstream repos (see pipeline above).
- New component:
  1. Add a mapping in the right fetcher: `KEY_MAP` / `COMPOSE_IMAGE_MAP` (community), `IMAGE_MAP` / `ENV_KEY_MAP` / `QUAY_IMAGE` (enterprise).
  2. For Docker Hub images, add a `DOCKER_IMAGE` entry in `resolve-latest.js`. quay.io images carry their own `dockerImage` and need no entry.
  3. Add the key to `CATEGORIES` and `DISPLAY_NAMES` in `index.html`.
