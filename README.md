# Alfresco Compatibility Matrix

A static site that shows the latest compatible component versions for each ACS (Alfresco Content Services) release — both Community and Enterprise editions. Data is refreshed automatically every Monday and deployed to GitHub Pages.

## How it works

The pipeline has three steps:

```
fetch-community.js  ─┐
                     ├──► resolve-latest.js ──► data/matrix.json ──► index.html
fetch-enterprise.js ─┘
```

| Script | Source | Output |
|---|---|---|
| `fetch-community.js` | `.env` files from [alfresco-docker-installer](https://github.com/Alfresco/alfresco-docker-installer) | `data/raw-community.json` |
| `fetch-enterprise.js` | `compose.yaml` at each stable tag of [acs-deployment](https://github.com/Alfresco/acs-deployment); ACS 7.x fallback from [alfresco-enterprise-docker](https://github.com/AlfrescoLabs/alfresco-enterprise-docker) | `data/raw-enterprise.json` |
| `resolve-latest.js` | Docker Hub (public images) and quay.io (enterprise images) | `data/matrix.json` |

The frontend (`index.html` + `style.css`) is a single static page with no build step. It fetches `data/matrix.json` at runtime and renders the table.

## Local development

```bash
npm ci
npm run build   # fetch + resolve — requires quay.io credentials for enterprise patch resolution
npm run serve   # preview at http://localhost:3000
```

Individual steps:

```bash
npm run fetch   # fetch-community.js + fetch-enterprise.js
npm run resolve # resolve-latest.js
```

### quay.io credentials

Enterprise images live on `quay.io` (private). Patch resolution requires credentials:

```bash
docker login quay.io   # stores credentials in the OS keychain
```

The script picks them up automatically from the macOS keychain via `docker-credential-osxkeychain`. Without credentials, enterprise components show `base = latest`.

## GitHub Actions setup

The workflow (`.github/workflows/refresh.yml`) runs every Monday at 06:00 UTC and deploys to GitHub Pages.

**Required repository secrets:**

| Secret | Description |
|---|---|
| `QUAY_USER` | quay.io username |
| `QUAY_PASSWORD` | quay.io password or robot token |

The `GITHUB_TOKEN` secret is provided automatically by Actions.

**Enable GitHub Pages:** go to *Settings → Pages* and set the source to *GitHub Actions*.

## Data files

| File | Description |
|---|---|
| `data/raw-community.json` | Base component versions for each Community ACS release |
| `data/raw-enterprise.json` | Base component versions for each Enterprise ACS release |
| `data/matrix.json` | Final merged matrix with latest patch versions resolved |

## Adding a new ACS version

No code change is needed. Both scripts discover versions automatically:

- **Community** — queries the GitHub Contents API for version folders in `alfresco-docker-installer/generators/app/templates/`.
- **Enterprise** — queries the GitHub Tags API for all stable `vX.Y.Z` tags in `acs-deployment`.
