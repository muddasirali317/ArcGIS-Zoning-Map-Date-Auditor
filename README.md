# Zoning Map Date Auditor (Phase 3)

Reads a Google Sheet of ArcGIS map links, checks every endpoint, shows each map's date, review date, status and failure reason, lets you review the maps one by one, and exports CSVs (or writes the results back to the sheet).

## Run it

```
npm install
npm run dev        # server on :8787, web on http://localhost:5173
npm test           # all automated tests
```

Open http://localhost:5173, paste the sheet link (shared as "Anyone with the link can view"), press **Sync**. Checking starts automatically.

## What it does

**Checking.** Per map: service JSON, each checked layer's metadata, then one small statistics query per recognized date field (max, min, count). The Primary Date is the newest eligible date among recognized attribute fields and endpoint metadata (including editing information); every other date found is kept with its source and a link to the exact request that produced it.

**Viewer links (Phase 3).** ArcGIS Online / Enterprise viewer links are followed to the services behind them: app → web map → layers (Instant Apps, configurable apps, Experience Builder, Dashboards, Map Viewer `layers=`, Hub dataset links with an item id). The chain is shown under *Resolved from*. Portal item dates are recorded separately (*Item Modified Date*), flagged low confidence, and are used as the Primary Date only when nothing better exists, e.g. a web map whose data is stored inside it. Hub links that name a dataset instead of giving its id (`/datasets/ORG::name`) cannot be looked up; the row says what to paste instead.

**Optional fallback link column.** In the column screen, pick a second link column (for example a viewer link). It is used only for rows whose Map URL cell has no link.

**Review.** Map viewer with layers, legend, free OpenStreetMap/CARTO basemaps (no Esri API key required), opacity. Previous / Next and the arrow keys walk the filtered list; **Mark reviewed** stamps today's date.

**Re-runs.** Results are saved to SQLite (`data/auditor.db`) as they arrive. Sync queues only new or changed rows (City + State + link fingerprint). **Run pending** finishes an interrupted run, **Re-check failed**, **Re-check all**. A map that loaded is cached for 24 hours; failures never are. A dead host is skipped after 5 connection failures in a row (`HOST_UNREACHABLE`).

**Date-field suggestions (Phase 3).** Date fields whose names are not on the list are collected across all maps and ranked (update-style names first, creation-style last), with how many maps would gain a date. Tick the ones you want, add them to `config/config.json` in one click, then **Re-check those maps**.

## Exports

- **Full CSV**: City, County, State, Source Link, Endpoint, Feature Type, Primary Date, Review Date, Evidence URL, Issue, and Issue 2. The two issue cells carry the exact on-screen / server message (not a code): **Issue** holds problems found once the link opened — a secured or administrative-approval-required service, a stopped service, no layers, a viewer that could not be resolved, a render failure, an ArcGIS error, or a date warning; **Issue 2** holds the link itself never opening — a bad address, a dead or unreachable host, an HTTP 4xx/5xx, a timeout, a DNS/SSL failure, or a non-ArcGIS page. A clean map leaves both blank. **Primary Date** is the newest eligible date among attribute fields and endpoint metadata; when a map has no date of any kind, the **Review Date** is used in its place so every row still carries a date (the Issue columns say why).
- **Issues only**: the maps that did not load, with the same focused columns and the same two issue cells.
- **Sheet-ready**: your sheet exactly as it is, plus one consolidated `New date` column and 11 `Audit …` columns, one line per source line (blank lines kept, so a paste cannot shift anything). `New date` is the consolidated Primary Date, falling back to the Review Date for a row whose links found no date at all; `Audit Primary Date` still shows the raw result (including `None`), and `Audit Review Date` carries the review (recent) date unchanged. An existing `New date` column is populated instead of duplicated. A cell holding two links becomes one line with the two answers joined by `; `. Dates can be written as `YYYY-MM-DD` or `DD-MM-YYYY`. If the sheet already has a column with an `Audit …` header it is reused rather than duplicated.

All CSVs are UTF-8 with a BOM. Text that starts with `=`, `+`, `-` or `@` gets a leading apostrophe so Excel cannot run it as a formula.

## Private sheets and writing results back (needs one-time Google setup)

Public sheets need nothing. For a private sheet, or to write results into the sheet, you need your own Google OAuth client (the tool cannot create one for you):

1. In https://console.cloud.google.com create a project, enable the **Google Sheets API**.
2. *OAuth consent screen*: External, add yourself as a test user. *Credentials → Create OAuth client ID → Web application*, with the authorised redirect URI `http://127.0.0.1:8787/api/auth/google/callback`.
3. Start the server with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set (PowerShell: `$env:GOOGLE_CLIENT_ID='…'; $env:GOOGLE_CLIENT_SECRET='…'; npm run dev`).
4. In the tool: **Sign in with Google** (read-only). **Enable write-back** asks for edit access only when you click it.

Tokens live in the server's memory only, never on disk and never in the browser; restarting the server signs you out. Write-back touches only the `Audit …` columns, writes plain text (never formulas), shows you exactly which columns and rows first, and **refuses to write if the sheet changed since your last Sync** (a row inserted above would put results on the wrong rows).

The sign-in and write-back code is tested against a local stand-in for Google, not the real service.

## Maps that need a VPN

A browser VPN extension only reroutes browser traffic, not the Node server. Two options:

1. **Re-check failed in browser (VPN)**: turn the VPN on in the browser, then click the button in the top bar (or "Re-check in browser" on one row). The same engine runs in the browser and the results are saved. This works for servers that send CORS headers, which ArcGIS Server normally does; otherwise the row reports `CORS_BLOCKED`. The map viewer also talks to the city server from the browser, so the same VPN applies.
2. **System-wide VPN, or a proxy for the server**: set `UPSTREAM_PROXY=http://host:port` before `npm run dev`.

## Configuration

`config/config.json` is read on every Sync/Run (no restart): date field names, date selection, concurrency (20 global, 3 per host), timeouts, retries, breaker threshold, services checked per viewer link, cache TTL, layer cap, layer keywords, freshness thresholds. `DB_PATH` moves the database.

## Theme

The **Theme** button cycles match-system / light / dark and remembers the choice. `tests/theme.test.ts` checks that every text colour pair meets WCAG AA (4.5:1) in all theme states.

## Layout

- `packages/core`: URL normalizer, portal resolver, date detector, engine, classifier, queue, breaker, sync planner, filters, legend, suggestions, CSV (runs in Node and the browser)
- `apps/server`: Fastify API, SQLite store, Google sign-in, SSRF-guarded HTTP client, SSE progress
- `apps/web`: React UI
- `scripts/`: `audit-sheet.ts` (headless run of a sheet; `ALT_URL_COL=<n>` turns on the fallback column), `smoke-apps.mjs` (live check of viewer-link resolution), `check-sheet-ready.ts`
- `tests/`: Vitest suites; `tests/fixtures/real` holds saved real ArcGIS responses, including real portal items

## Decisions worth knowing

- "Issues" counts maps that failed to load. Warnings (`DUPLICATE_URL`, `DATE_*`, `AMBIGUOUS_FORMAT`) are shown but not counted.
- Codes added to the PRD taxonomy: `CONNECTION_FAILED`, `ARCGIS_ERROR`, `HOST_UNREACHABLE`.
- A failed map can still show a Primary Date when a portal item date was found before the service failed. It is labelled `Portal:item.modified`, low confidence; the Status column says it failed.
- Text dates are read in `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYYMMDD`, `D/M/Y` or `M/D/Y` (day/month order settled from the rest of the field, never guessed), and month-name forms (`May 14, 2023`, `14-MAY-2023`, `14 May 23`) with any of space / `,` / `.` / `/` / `-` as separators. Two-digit years read as 2000–2069 / 1970–1999. A lone ambiguous value (e.g. `03/04/2023`) is reported, not guessed. Epoch values are milliseconds; a value only plausible as epoch seconds for a modern date is rescaled, and a value whose year falls outside 0001–9999 is treated as a units mistake and ignored.
- No date anywhere: the exported Primary Date (and the sheet's `New date`) fall back to the Review Date, so the client sheet always receives a date; the row's status and Issue columns still show that no real date was found. For a hard link failure this stamps today's date on a row whose link is broken — the Issue 2 column flags that, so an analyst can tell a verified date from a fallback stamp.
- A map that fails to draw in the viewer gets a `MAP_RENDER_FAILED` note on the row; its status is not changed.
- Free text in service descriptions is not scanned for dates.
- ETag / If-Modified-Since is not used: ArcGIS JSON endpoints rarely support it, so the 24 h cache does that job.
- SQLite is Node's built-in `node:sqlite`, which prints an "experimental" warning at start-up.
