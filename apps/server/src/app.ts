import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  assertCsvResponse,
  buildRows,
  buildWriteBackMatrix,
  csvExportUrl,
  parseCsv,
  parseSheetUrl,
  planSync,
  rebrandResult,
  resolveConfig,
  SheetError,
  suggestMapping,
  type CheckResult,
  type CheckRow,
  type ColumnMapping,
  type Config,
  type DateFormat,
  type HttpClient,
  type RawConfig,
  type SyncMode,
} from '@zoning/core';
import { addDateFieldNames } from './configEdit';
import { Store } from './db';
import { columnLetter, GoogleAuth, readTab, writeColumns, type GoogleOptions } from './google';
import { createHttpClient } from './http-client';
import { RunRegistry } from './runs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
export const DEFAULT_CONFIG_PATH = resolve(ROOT, 'config/config.json');
export const DEFAULT_DB_PATH = process.env.DB_PATH ?? resolve(ROOT, 'data/auditor.db');

export interface AppOptions {
  configPath?: string;
  /** SQLite file, or ':memory:'. */
  dbPath?: string;
  /** Override the HTTP client (tests). */
  http?: HttpClient;
  /** Tests only. */
  allowPrivateHosts?: boolean;
  upstreamProxy?: string;
  /** Google sign-in settings; defaults come from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI. Tests point it at a local stand-in. */
  google?: Partial<GoogleOptions>;
}

export function loadRawConfig(path: string): RawConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
}

export const sheetKeyOf = (url: string) => {
  const ref = parseSheetUrl(url);
  return `${ref.sheetId}:${ref.gid}`;
};

const SYNC_MODES = ['changed', 'failed', 'nodate', 'all'];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The table exactly as the sheet has it: blank lines in the middle are kept so row numbers match; trailing blanks are dropped. */
function trimTrailingBlankRows(table: string[][]): string[][] {
  let end = table.length;
  while (end > 0 && table[end - 1].every((c) => c.trim() === '')) end--;
  return table.slice(0, end);
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 40 * 1024 * 1024 });
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const store = new Store(opts.dbPath ?? DEFAULT_DB_PATH);
  const runs = new RunRegistry();
  const auth = new GoogleAuth({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://127.0.0.1:8787/api/auth/google/callback',
    ...opts.google,
  });

  // Read per request: editing config.json takes effect on the next Sync / Run without a restart.
  const config = (): { raw: RawConfig; resolved: Config } => {
    const raw = loadRawConfig(configPath);
    return { raw, resolved: resolveConfig(raw) };
  };
  // One connection pool per distinct set of limits, reused across runs.
  const clients = new Map<string, HttpClient>();
  const makeHttp = (c: Config): HttpClient => {
    if (opts.http) return opts.http;
    const o = { connectMs: c.timeouts.connectMs, totalMs: c.timeouts.totalMs, maxBytes: c.maxResponseBytes, allowPrivateHosts: opts.allowPrivateHosts, upstreamProxy: opts.upstreamProxy ?? process.env.UPSTREAM_PROXY };
    const key = JSON.stringify(o);
    let client = clients.get(key);
    if (!client) clients.set(key, (client = createHttpClient(o)));
    return client;
  };
  app.addHook('onClose', async () => {
    for (const c of clients.values()) await (c as { close?: () => Promise<void> }).close?.();
    store.close();
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({ config: config().raw, upstreamProxy: Boolean(opts.upstreamProxy ?? process.env.UPSTREAM_PROXY) }));

  /** Add names to config/config.json (the suggestions panel). Takes effect on the next check. */
  app.post<{ Body: { names: string[] } }>('/api/config/date-fields', async (req, reply) => {
    if (!Array.isArray(req.body?.names) || req.body.names.length === 0) return reply.code(400).send({ error: 'names is required.' });
    try {
      return addDateFieldNames(configPath, req.body.names);
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- Google sign-in ---------------------------------------------------------------
  app.get('/api/auth/status', async () => auth.status());
  app.post('/api/auth/signout', async () => {
    auth.signOut();
    return auth.status();
  });
  app.get<{ Querystring: { write?: string } }>('/api/auth/google/start', async (req, reply) => {
    try {
      return reply.redirect(auth.start(req.query.write === '1'));
    } catch (e) {
      return reply.code(501).type('text/html').send(`<p>${esc(e instanceof Error ? e.message : String(e))}</p>`);
    }
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/google/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    try {
      if (error || !code || !state) throw new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google did not complete the sign-in${error ? ` (${error})` : ''}.`);
      await auth.handleCallback(code, state);
      return reply.type('text/html').send('<!doctype html><title>Signed in</title><body style="font:16px system-ui;padding:2rem"><h2>Signed in</h2><p>You can close this tab and go back to the Zoning Map Date Auditor.</p>');
    } catch (e) {
      return reply.code(400).type('text/html').send(`<!doctype html><title>Sign-in failed</title><body style="font:16px system-ui;padding:2rem"><h2>Sign-in failed</h2><p>${esc(e instanceof Error ? e.message : String(e))}</p>`);
    }
  });

  // ---- Reading the sheet -------------------------------------------------------------
  // On the server: Google sends no CORS headers for the CSV export. A private sheet is read through the Sheets API once signed in.
  app.post<{ Body: { url: string } }>('/api/sheet', async (req, reply) => {
    try {
      const ref = parseSheetUrl(req.body?.url ?? '');
      let table: string[][];
      try {
        const res = await makeHttp(config().resolved).get(csvExportUrl(ref));
        assertCsvResponse(res.status, res.body);
        table = parseCsv(res.body);
      } catch (e) {
        if (!(e instanceof SheetError) || e.code !== 'SHEET_PRIVATE' || !auth.status().signedIn) throw e;
        table = await readTab(auth, ref.sheetId, ref.gid);
      }
      table = trimTrailingBlankRows(table);
      if (table.length < 2) throw new SheetError('SHEET_EMPTY', 'That tab has no data rows. Check that the link points at the right tab (gid).');
      return { ...ref, table, mapping: suggestMapping(table[0], table.slice(1, 60)) };
    } catch (e) {
      if (e instanceof SheetError) {
        const extra = e.code === 'SHEET_PRIVATE' ? { canSignIn: auth.configured, signedIn: auth.status().signedIn } : {};
        return reply.code(e.code === 'SHEET_URL_INVALID' ? 400 : 422).send({ error: e.message, code: e.code, ...extra });
      }
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(502).send({ error: `Could not read the sheet: ${message}`, code: 'SHEET_FETCH_FAILED' });
    }
  });

  /** What is stored for a sheet: rows, results matched to those rows, and rows removed from the sheet. */
  const stateOf = (key: string) => {
    const sheet = store.getSheet(key);
    if (!sheet) return null;
    const stored = store.getResults(key);
    const results: CheckResult[] = [];
    for (const row of sheet.rows) {
      const r = stored.get(row.fingerprint);
      if (r) results.push(rebrandResult(r, row, new Date(), { keepReview: true }));
    }
    const removed = sheet.removed.map((row) => ({ row, result: stored.get(row.fingerprint) ?? null }));
    return { url: sheet.url, rows: sheet.rows, results, removed, syncedAt: sheet.syncedAt, table: sheet.table, mapping: sheet.mapping };
  };

  app.get<{ Querystring: { sheetKey: string } }>('/api/state', async (req, reply) => {
    const s = stateOf(req.query.sheetKey ?? '');
    return s ?? reply.code(404).send({ error: 'Nothing stored for that sheet yet.' });
  });

  /**
   * Compare the sheet's rows with what was stored, queue only what needs checking, and return the
   * stored results to show immediately. `mode`: changed (new, changed or never finished), failed
   * (those plus every failure), nodate (those plus maps that loaded without a date), all (everything, bypassing the cache).
   */
  app.post<{ Body: { sheetKey: string; sheetUrl?: string; rows: CheckRow[]; mode?: SyncMode; table?: string[][]; mapping?: ColumnMapping } }>('/api/sync', async (req, reply) => {
    const { sheetKey, rows, mode = 'changed' } = req.body ?? ({} as never);
    if (!sheetKey || !Array.isArray(rows)) return reply.code(400).send({ error: 'sheetKey and rows are required.' });
    if (!SYNC_MODES.includes(mode)) return reply.code(400).send({ error: 'Unknown mode.' });

    const prev = store.getSheet(sheetKey);
    const stored = store.getResults(sheetKey);
    const plan = planSync(prev?.rows ?? [], rows, stored, mode);

    const nextFps = new Set(rows.map((r) => r.fingerprint));
    const removedByFp = new Map<string, CheckRow>();
    for (const r of [...(prev?.removed ?? []), ...plan.removed]) if (!nextFps.has(r.fingerprint)) removedByFp.set(r.fingerprint, r);
    store.saveSheet(sheetKey, req.body.sheetUrl ?? prev?.url ?? '', rows, [...removedByFp.values()], req.body.table, req.body.mapping);

    const queued = new Set(plan.toCheck.map((r) => r.id));
    const carried: CheckResult[] = [];
    for (const row of rows) {
      const r = stored.get(row.fingerprint);
      if (r && !queued.has(row.id)) carried.push(rebrandResult(r, row, new Date(), { keepReview: true }));
    }

    let runId: string | null = null;
    if (plan.toCheck.length > 0) {
      const c = config().resolved;
      runId = runs.create({ rows: plan.toCheck, http: makeHttp(c), config: c, store, sheetKey, force: mode !== 'changed' }).id;
    }
    return {
      runId,
      counts: { total: rows.length, unchanged: plan.unchanged.length, changed: plan.changed.length, added: plan.added.length, removed: removedByFp.size, queued: plan.toCheck.length },
      results: carried,
      removed: [...removedByFp.values()].map((row) => ({ row, result: stored.get(row.fingerprint) ?? null })),
    };
  });

  /** Save results changed on the client: reviewer / note edits, Mark as reviewed, browser re-checks. */
  app.put<{ Body: { sheetKey: string; items: { fingerprint: string; result: CheckResult }[] } }>('/api/results', async (req, reply) => {
    const { sheetKey, items } = req.body ?? ({} as never);
    if (!sheetKey || !Array.isArray(items)) return reply.code(400).send({ error: 'sheetKey and items are required.' });
    store.putResults(sheetKey, items);
    return { saved: items.length };
  });

  // ---- Write the audit columns back to the Google Sheet --------------------------------
  /**
   * `confirm: false` returns what would be written; `confirm: true` writes it. Before either, the sheet is
   * read again and compared with the last Sync: if any row moved or changed, nothing is written.
   * Only result columns are touched; an existing `New date` column is reused rather than duplicated.
   */
  app.post<{ Body: { sheetKey: string; confirm?: boolean; dateFormat?: DateFormat } }>('/api/sheets/write-back', async (req, reply) => {
    const { sheetKey, confirm = false, dateFormat = 'iso' } = req.body ?? ({} as never);
    const st = auth.status();
    if (!st.signedIn || !st.canWrite) return reply.code(403).send({ error: 'Write-back is not enabled. Sign in with Google and allow editing first.', code: 'WRITE_NOT_ENABLED', canSignIn: auth.configured });
    const rec = sheetKey ? store.getSheet(sheetKey) : null;
    if (!rec?.table || !rec.mapping) return reply.code(409).send({ error: 'Sync the sheet first, then write the results back.', code: 'NOT_SYNCED' });
    const [sheetId, gid] = sheetKey.split(':');

    try {
      const live = trimTrailingBlankRows(await readTab(auth, sheetId, gid));
      const liveRows = buildRows(live, rec.mapping as ColumnMapping).rows;
      const liveFp = new Map(liveRows.map((r) => [r.id, r.fingerprint]));
      const storedFp = new Map(rec.rows.map((r) => [r.id, r.fingerprint]));
      const moved = [...new Set([...liveFp.keys(), ...storedFp.keys()])].filter((id) => liveFp.get(id) !== storedFp.get(id));
      if (moved.length > 0) {
        return reply.code(409).send({
          error: `The sheet changed since the last Sync (for example row ${moved[0]}), so writing now could put results on the wrong rows. Press Sync, then write the results again.`,
          code: 'SHEET_CHANGED',
          changedRows: moved.length,
        });
      }

      const stored = store.getResults(sheetKey);
      const results: Record<string, CheckResult> = {};
      for (const row of rec.rows) {
        const r = stored.get(row.fingerprint);
        if (r) results[row.id] = rebrandResult(r, row, new Date(), { keepReview: true });
      }
      const matrix = buildWriteBackMatrix(live, rec.rows, results, dateFormat);
      const cols = matrix.columns.map((c, k) => ({ index: c.index, name: c.name, cells: matrix.audit.map((r) => r[k]) }));
      const existing = cols.filter((c) => c.index < (live[0]?.length ?? 0) && (live[0][c.index] ?? '').trim() !== '');
      const summary = {
        rows: live.length - 1,
        checked: Object.keys(results).length,
        columns: cols.map((c) => `${columnLetter(c.index)}: ${c.name}`),
        replacesExisting: existing.map((c) => `${columnLetter(c.index)}: ${c.name}`),
      };
      if (!confirm) return { dryRun: true, summary };
      await writeColumns(auth, sheetId, gid, cols);
      return { written: true, summary };
    } catch (e) {
      if (e instanceof SheetError) return reply.code(e.code === 'SHEET_PRIVATE' ? 403 : 422).send({ error: e.message, code: e.code });
      return reply.code(502).send({ error: `Could not write to the sheet: ${e instanceof Error ? e.message : String(e)}`, code: 'WRITE_FAILED' });
    }
  });

  // Low-level: queue exactly these rows (used by scripts and tests). Results are stored under `sheetKey` ("adhoc" by default).
  app.post<{ Body: { rows: CheckRow[]; sheetKey?: string; force?: boolean } }>('/api/runs', async (req, reply) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) return reply.code(400).send({ error: 'No rows to check.' });
    const c = config().resolved;
    const run = runs.create({ rows, http: makeHttp(c), config: c, store, sheetKey: req.body.sheetKey ?? 'adhoc', force: req.body.force });
    return { id: run.id, total: rows.length };
  });

  const find = (id: string) => runs.get(id);

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = find(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Unknown run.' });
    return { id: run.id, stats: run.stats, results: [...run.results.values()], openHosts: run.breaker.openHosts() };
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post<{ Params: { id: string } }>(`/api/runs/:id/${action}`, async (req, reply) => {
      const run = find(req.params.id);
      if (!run) return reply.code(404).send({ error: 'Unknown run.' });
      run[action]();
      return { stats: run.stats };
    });
  }

  // Server-Sent Events: one snapshot on connect (so a reloaded tab catches up), then one event per result.
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', (req, reply) => {
    const run = find(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Unknown run.' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let lastProgress = 0;
    const unsubscribe = run.subscribe((e) => {
      if (e.type === 'progress') {
        // Counts change on every result; throttle the stream but always send state changes.
        const now = Date.now();
        if (now - lastProgress < 150 && e.stats.state === 'running') return;
        lastProgress = now;
      }
      send(e.type, e.type === 'result' ? e.result : e.type === 'progress' ? e.stats : e);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
