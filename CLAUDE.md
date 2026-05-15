# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm ci

# Fetch raw data from upstream repos (writes data/raw-community.json and data/raw-enterprise.json)
npm run fetch

# Resolve latest patches from Docker Hub (reads raw-*.json, writes data/matrix.json)
npm run resolve

# Full pipeline: fetch + resolve
npm run build

# Preview the static site locally
npm run serve
```

There is no test suite and no linter configured.

## Architecture

This is a static site with a Node.js data pipeline — no framework, no bundler.

**Data pipeline** (`scripts/`) runs at build time and produces the single data file the frontend reads:

1. `fetch-community.js` — fetches `.env` files from `alfresco/alfresco-docker-installer` on GitHub, parses `KEY_MAP` env vars into component objects, writes `data/raw-community.json`.
2. `fetch-enterprise.js` — fetches `docker-compose` YAML files from `alfresco/acs-deployment` on GitHub, maps `IMAGE_MAP` regex patterns against service image strings, writes `data/raw-enterprise.json`.
3. `resolve-latest.js` — reads both raw files, queries Docker Hub's tag API for each component to find the highest stable patch in the same `major.minor` train, merges results into `data/matrix.json` with a `generated` timestamp.

`matrix.json` schema:
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
          "latest": "<highest patch found on Docker Hub>",
          "dockerImage": "<ns/image>",
          "engine": "solr6|elasticsearch"   // search only
        }
      }
    }
  ]
}
```

**Frontend** (`index.html` + `style.css`) is a single self-contained HTML file. All JS is in an inline `<script>` IIFE. It fetches `data/matrix.json` at runtime, then renders a filterable table via `CATEGORIES` (grouping) and `DISPLAY_NAMES` (labels). No build step is needed for the frontend.

**CI** (`.github/workflows/refresh.yml`) runs every Monday at 06:00 UTC: installs deps → runs the three scripts individually → deploys the whole directory to GitHub Pages.

## Key extension points

- **New ACS versions are discovered automatically** — Community via the GitHub Contents API (version folders in `alfresco-docker-installer/generators/app/templates/`); Enterprise via GitHub Tags API (stable `vX.Y.Z` tags of `acs-deployment`). No code change needed when Alfresco ships a new release.
- **Map a new image to a component**: add an entry to `IMAGE_MAP` (enterprise) or `KEY_MAP` (community), add a `DOCKER_IMAGE` entry in `resolve-latest.js`, and add display/category entries in the inline JS in `index.html`.
- **Add a new component category in the UI**: edit `CATEGORIES` and `DISPLAY_NAMES` in `index.html`.
