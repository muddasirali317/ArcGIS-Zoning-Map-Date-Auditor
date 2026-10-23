/**
 * Google sign-in, private sheets, write-back and config editing, against a LOCAL STAND-IN for Google
 * (tests/helpers/mockGoogle.ts). This proves the tool's side of the protocol; it has not been run against real Google.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeName, resolveConfig, WRITEBACK_COLUMNS, type CheckRow } from '@zoning/core';
import { buildApp } from '../apps/server/src/app';
import { addDateFieldNames } from '../apps/server/src/configEdit';
import { columnLetter } from '../apps/server/src/google';
import { rawConfig, reply } from './helpers';
import { startMockGoogle, type MockGoogle } from './helpers/mockGoogle';
import { makeRows, startMockArcgis, type MockArcgis } from './helpers/mockArcgis';

let google: MockGoogle;
let arcgis: MockArcgis;
let tmp: string;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  google = await startMockGoogle({ sheetId: 'SHEET123', tabTitle: "Zoning O'Brien", gid: 0 });
  arcgis = await startMockArcgis();
  tmp = mkdtempSync(join(tmpdir(), 'zoning-g-'));
});
afterAll(async () => {
  await google.close();
  await arcgis.close();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/SHEET123/edit#gid=0';
const HTML_LOGIN = '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head>';

function newApp(over: { configured?: boolean; csv?: string } = {}) {
  const app = buildApp({
    dbPath: ':memory:',
    allowPrivateHosts: true,
    // The sheet's public CSV export: a login page (private sheet), or the CSV given.
    http: undefined,
    google: { clientId: over.configured === false ? undefined : 'client-123', clientSecret: 'secret', redirectUri: 'http://127.0.0.1:8787/cb', authBase: `${google.base}/auth`, tokenUrl: `${google.base}/token`, sheetsBase: `${google.base}/v4` },
  });
  apps.push(app);
  return app;
}

/** An app whose public CSV export answers with `csv`, or a Google login page when csv is undefined. */
function appWithCsv(csv?: string, configured = true) {
  const app = buildApp({
    dbPath: ':memory:',
    http: { get: async () => (csv === undefined ? reply(HTML_LOGIN) : reply(csv, 200, { 'content-type': 'text/csv' })) },
    google: { clientId: configured ? 'client-123' : undefined, redirectUri: 'http://127.0.0.1:8787/cb', authBase: `${google.base}/auth`, tokenUrl: `${google.base}/token`, sheetsBase: `${google.base}/v4` },
  });
  apps.push(app);
  return app;
}

async function signIn(app: FastifyInstance, write: boolean) {
  const start = await app.inject({ url: `/api/auth/google/start${write ? '?write=1' : ''}` });
  expect(start.statusCode).toBe(302);
  const authUrl = start.headers.location as string;
  google.expectAuth(authUrl);
  const state = new URL(authUrl).searchParams.get('state')!;
  const cb = await app.inject({ url: `/api/auth/google/callback?code=goodcode&state=${state}` });
  expect(cb.statusCode).toBe(200);
  return { authUrl, state };
}

describe('Google sign-in', () => {
  it('without credentials: says so, and reports it is not configured', async () => {
    const app = appWithCsv(undefined, false);
    expect((await app.inject({ url: '/api/auth/status' })).json()).toEqual({ configured: false, signedIn: false, canWrite: false });
    const start = await app.inject({ url: '/api/auth/google/start' });
    expect(start.statusCode).toBe(501);
    expect(start.body).toContain('GOOGLE_CLIENT_ID');
  });

  it('read-only scope by default, with PKCE (S256), a random state and offline access', async () => {
    const app = newApp();
    const { authUrl } = await signIn(app, false);
    const q = new URL(authUrl).searchParams;
    expect(authUrl.startsWith(`${google.base}/auth?`)).toBe(true);
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')!.length).toBeGreaterThan(30);
    expect(q.get('state')!.length).toBeGreaterThan(20);
    expect(q.get('client_id')).toBe('client-123');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:8787/cb');
    expect(q.get('access_type')).toBe('offline');
    expect((await app.inject({ url: '/api/auth/status' })).json()).toEqual({ configured: true, signedIn: true, canWrite: false });
  });

  it('the write scope is requested only on demand', async () => {
    const app = newApp();
    const { authUrl } = await signIn(app, true);
    expect(new URL(authUrl).searchParams.get('scope')).toBe('https://www.googleapis.com/auth/spreadsheets');
    expect((await app.inject({ url: '/api/auth/status' })).json().canWrite).toBe(true);
  });

  it('rejects a callback with an unknown state, a cancelled sign-in, and a state used twice', async () => {
    const app = newApp();
    const bad = await app.inject({ url: '/api/auth/google/callback?code=goodcode&state=nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Sign-in failed');
    const denied = await app.inject({ url: '/api/auth/google/callback?error=access_denied' });
    expect(denied.body).toContain('cancelled');
    const { state } = await signIn(app, false);
    const replay = await app.inject({ url: `/api/auth/google/callback?code=goodcode&state=${state}` });
    expect(replay.statusCode).toBe(400);
  });

  it('a wrong PKCE verifier or code is refused by Google and nobody is signed in', async () => {
    const app = newApp();
    const start = await app.inject({ url: '/api/auth/google/start' });
    google.expectAuth(start.headers.location as string);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await app.inject({ url: `/api/auth/google/callback?code=WRONG&state=${state}` });
    expect(cb.statusCode).toBe(400);
    expect((await app.inject({ url: '/api/auth/status' })).json().signedIn).toBe(false);
  });

  it('page output escapes anything echoed from the URL', async () => {
    const app = newApp();
    const r = await app.inject({ url: '/api/auth/google/callback?error=%3Cscript%3Ealert(1)%3C/script%3E' });
    expect(r.body).not.toContain('<script>alert');
  });

  it('sign out forgets the tokens', async () => {
    const app = newApp();
    await signIn(app, true);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signout' })).json().signedIn).toBe(false);
  });

  it('tokens are never sent to the browser', async () => {
    const app = newApp();
    await signIn(app, true);
    const bodies = [(await app.inject({ url: '/api/auth/status' })).body, (await app.inject({ url: '/api/config' })).body];
    for (const b of bodies) expect(b).not.toMatch(/at\d|rt1|access_token|refresh_token/);
  });
});

describe('private sheets', () => {
  it('a private sheet without sign-in: the PRD message plus whether sign-in is possible', async () => {
    const r = await appWithCsv(undefined, true).inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET_URL } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: 'SHEET_PRIVATE', canSignIn: true, signedIn: false, error: 'Sheet is private. Share as "Anyone with the link" or sign in with Google.' });
    const noCreds = await appWithCsv(undefined, false).inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET_URL } });
    expect(noCreds.json().canSignIn).toBe(false);
  });

  it('after sign-in the sheet is read through the Sheets API: hyperlinks kept, blank line kept, trailing blanks dropped', async () => {
    google.setGrid([
      ['City', 'State', 'Map'],
      ['Austin', 'TX', { text: 'Zoning map', link: 'https://gis.austin.gov/arcgis/rest/services/Z/MapServer' }],
      ['', '', ''],
      ['Dallas', 'TX', 'https://gis.dallas.gov/arcgis/rest/services/Z/MapServer'],
      ['', '', ''],
      ['', '', ''],
    ]);
    const app = appWithCsv(undefined, true);
    await signIn(app, false);
    const r = await app.inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET_URL } });
    expect(r.statusCode).toBe(200);
    const { table, mapping } = r.json();
    expect(table).toHaveLength(4); // header, Austin, the blank line (kept so row numbers match), Dallas
    expect(table[1][2]).toBe('Zoning map https://gis.austin.gov/arcgis/rest/services/Z/MapServer');
    expect(table[3][2]).toBe('https://gis.dallas.gov/arcgis/rest/services/Z/MapServer');
    expect(mapping).toMatchObject({ city: 0, state: 1, url: 2 });
  });

  it('a wrong tab (gid) is explained, and a sheet the account cannot open says so', async () => {
    const app = appWithCsv(undefined, true);
    await signIn(app, false);
    const wrongTab = await app.inject({ method: 'POST', url: '/api/sheet', payload: { url: 'https://docs.google.com/spreadsheets/d/SHEET123/edit#gid=555' } });
    expect(wrongTab.statusCode).toBe(422);
    expect(wrongTab.json().error).toContain('gid=555');
    google.forbid('SHEETXYZ');
    const forbidden = await app.inject({ method: 'POST', url: '/api/sheet', payload: { url: 'https://docs.google.com/spreadsheets/d/SHEETXYZ/edit' } });
    expect(forbidden.statusCode).toBe(422);
    expect(forbidden.json().code).toBe('SHEET_PRIVATE');
  });

  it('an expired access token is refreshed with the refresh token and the call is retried', async () => {
    google.setGrid([['City', 'State', 'Map'], ['A', 'TX', 'https://a.gov/x/MapServer']]);
    const app = appWithCsv(undefined, true);
    await signIn(app, false);
    const before = google.tokenCalls.length;
    google.expireTokens();
    const r = await app.inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET_URL } });
    expect(r.statusCode).toBe(200);
    const refreshes = google.tokenCalls.slice(before).filter((c) => c.grant_type === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].refresh_token).toBe('rt1');
  });

  it('a public blank line in the CSV is also kept (row numbers match the real sheet)', async () => {
    const app = appWithCsv('City,State,Map\nA,TX,https://a.gov/x/MapServer\n,,\nB,TX,https://b.gov/x/MapServer\n,,\n', true);
    const r = await app.inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET_URL } });
    expect(r.json().table).toHaveLength(4);
  });
});

describe('write-back', () => {
  /** A signed-in app with a synced sheet of 6 real checks stored. */
  async function synced(write: boolean) {
    const rows: CheckRow[] = makeRows(arcgis.origin, 6);
    const table = [['City', 'State', 'Zoning URL', 'Notes'], ...rows.map((r) => [r.city, r.state, r.url, r.id === '4' ? '=1+1' : 'keep'])];
    const mapping = { city: 0, state: 1, county: null, url: 2 };
    const app = buildApp({
      dbPath: ':memory:',
      allowPrivateHosts: true,
      google: { clientId: 'client-123', clientSecret: 's', redirectUri: 'http://127.0.0.1:8787/cb', authBase: `${google.base}/auth`, tokenUrl: `${google.base}/token`, sheetsBase: `${google.base}/v4` },
    });
    apps.push(app);
    const res = (await app.inject({ method: 'POST', url: '/api/sync', payload: { sheetKey: 'SHEET123:0', sheetUrl: SHEET_URL, rows, mode: 'changed', table, mapping } })).json();
    for (;;) {
      const snap = (await app.inject({ url: `/api/runs/${res.runId}` })).json();
      if (snap.stats.state === 'done') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    google.setGrid(table);
    google.writes.length = 0;
    if (write !== undefined) await signIn(app, write);
    return { app, rows, table };
  }

  const post = (app: FastifyInstance, payload: object) => app.inject({ method: 'POST', url: '/api/sheets/write-back', payload: { sheetKey: 'SHEET123:0', ...payload } });

  it('needs the write scope: not signed in, or signed in read-only, is refused with how to fix it', async () => {
    const { app } = await synced(false);
    const readOnly = await post(app, { confirm: true });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe('WRITE_NOT_ENABLED');
    expect(google.writes).toHaveLength(0);
    const fresh = appWithCsv(undefined, true);
    expect((await post(fresh, {})).statusCode).toBe(403);
  });

  it('dry run shows exactly where the columns would go and writes nothing', async () => {
    const { app } = await synced(true);
    const r = await post(app, { confirm: false });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.dryRun).toBe(true);
    expect(j.summary.rows).toBe(6);
    expect(j.summary.checked).toBe(6);
    expect(j.summary.columns).toHaveLength(WRITEBACK_COLUMNS.length);
    expect(j.summary.columns[0]).toBe('E: Primary Date'); // right after the sheet's 4 columns
    expect(j.summary.columns[1]).toBe('F: Updation Status');
    expect(j.summary.columns[2]).toBe('G: Last Reviewed');
    expect(j.summary.columns[3]).toBe('H: Map Issues');
    expect(j.summary.replacesExisting).toEqual([]);
    expect(google.writes).toHaveLength(0);
  });

  it('writes only the result columns, as RAW text, in one batch aimed at the right tab', async () => {
    const { app, rows } = await synced(true);
    const r = await post(app, { confirm: true });
    expect(r.json().written).toBe(true);
    expect(google.writes).toHaveLength(1);
    const { body } = google.writes[0];
    expect(body.valueInputOption).toBe('RAW');
    expect(body.data).toHaveLength(WRITEBACK_COLUMNS.length);
    expect(body.data[0].range).toBe("'Zoning O''Brien'!E1:E7"); // Primary Date
    expect(body.data[1].range).toBe("'Zoning O''Brien'!F1:F7"); // Updation Status
    expect(body.data[2].range).toBe("'Zoning O''Brien'!G1:G7"); // Last Reviewed
    expect(body.data[3].range).toBe("'Zoning O''Brien'!H1:H7"); // Map Issues
    for (const d of body.data) {
      expect(d.majorDimension).toBe('COLUMNS');
      expect(d.values[0]).toHaveLength(7); // header + 6 rows, aligned with the sheet
      const col = d.range.split('!')[1][0];
      expect(['A', 'B', 'C', 'D']).not.toContain(col); // never one of the analyst's columns
    }
    const primary = body.data[0].values[0];
    expect(primary[0]).toBe('Primary Date');
    expect(primary[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const status = body.data[1].values[0];
    expect(status[0]).toBe('Updation Status');
    expect(status.slice(1)).toEqual(rows.map(() => 'Updation')); // dates found, sheet has no New_Date baseline -> Updation
    const recent = body.data[2].values[0];
    expect(recent[0]).toBe('Last Reviewed');
    expect(recent[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // the date the tool checked the row
    const issues = body.data[3].values[0];
    expect(issues[0]).toBe('Map Issues');
    expect(issues.slice(1)).toEqual(rows.map(() => '')); // every map loaded cleanly: no issue
  });

  it('can write dates the way the analyst\'s own columns do (DD-MM-YYYY)', async () => {
    const { app } = await synced(true);
    await post(app, { confirm: true, dateFormat: 'dmy' });
    expect(google.writes[0].body.data[0].values[0][1]).toMatch(/^\d{2}-\d{2}-\d{4}$/);
  });

  it('reuses existing Primary Date / Map Issues columns instead of appending a second copy', async () => {
    const { app, table } = await synced(true);
    google.setGrid(table.map((r, i) => (i === 0 ? [...r, 'Map Issues'] : [...r, 'old'])));
    // the stored sync must match the live sheet for the write to be allowed: the new column is not part of the key columns
    const dry = await post(app, { confirm: false });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().summary.replacesExisting).toEqual(['E: Map Issues']);
    expect(dry.json().summary.columns[0]).toBe('F: Primary Date'); // appended after the used columns
    expect(dry.json().summary.columns[1]).toBe('G: Updation Status'); // appended
    expect(dry.json().summary.columns[2]).toBe('H: Last Reviewed'); // appended
    expect(dry.json().summary.columns[3]).toBe('E: Map Issues'); // reuses the existing column
  });

  it('reuses an existing Last Reviewed column for the recent date, keeping its header', async () => {
    const { app, table } = await synced(true);
    google.setGrid(table.map((r, i) => (i === 0 ? [...r, 'Last Reviewed'] : [...r, 'old rev'])));
    const dry = await post(app, { confirm: false });
    expect(dry.statusCode).toBe(200);
    const cols = dry.json().summary.columns;
    expect(cols[2]).toBe('E: Last Reviewed'); // the existing column is reused in place, header kept
    expect(dry.json().summary.replacesExisting).toEqual(['E: Last Reviewed']);
  });

  it('keeps the sheet\'s New date column as the comparison baseline — it is never overwritten', async () => {
    const { app, table } = await synced(true);
    google.setGrid(table.map((r, i) => (i === 0 ? [...r, 'New_Date'] : [...r, '01-01-2000'])));
    const dry = await post(app, { confirm: false });
    expect(dry.statusCode).toBe(200);
    const cols = dry.json().summary.columns;
    // all write-back columns are appended after New_Date; New_Date itself is not among them
    expect(cols).toEqual(['F: Primary Date', 'G: Updation Status', 'H: Last Reviewed', 'I: Map Issues']);
    expect(dry.json().summary.replacesExisting).toEqual([]); // nothing existing is replaced
  });

  it('REFUSES to write when the sheet changed since the last Sync (a row inserted would put results on the wrong rows)', async () => {
    const { app, table } = await synced(true);
    const inserted = [table[0], ['New City', 'ZZ', 'https://new.gov/x/MapServer', 'new'], ...table.slice(1)];
    google.setGrid(inserted);
    const r = await post(app, { confirm: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('SHEET_CHANGED');
    expect(r.json().error).toContain('Press Sync');
    expect(google.writes).toHaveLength(0);
  });

  it('also refuses when a link was edited in the sheet, or rows were removed', async () => {
    const { app, table } = await synced(true);
    google.setGrid(table.map((r, i) => (i === 2 ? [r[0], r[1], 'https://changed.gov/x/MapServer', r[3]] : r)));
    expect((await post(app, { confirm: true })).statusCode).toBe(409);
    google.setGrid(table.slice(0, 5));
    expect((await post(app, { confirm: true })).statusCode).toBe(409);
    expect(google.writes).toHaveLength(0);
  });

  it('a sheet that was never synced cannot be written to', async () => {
    const app = appWithCsv(undefined, true);
    await signIn(app, true);
    const r = await post(app, { confirm: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('NOT_SYNCED');
  });

  it('a Google error while writing is reported, not swallowed', async () => {
    const { app } = await synced(true);
    google.failNextSheetsCall(500); // the tab lookup fails
    const r = await post(app, { confirm: true });
    expect([422, 502]).toContain(r.statusCode);
    expect(r.json().error).toBeTruthy();
    expect(google.writes).toHaveLength(0);
  });

  it('column letters', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('adding date-field names to the config', () => {
  const fresh = () => {
    const path = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, readFileSync(join(__dirname, '../config/config.json'), 'utf8'));
    return path;
  };

  it('appends new names, skips ones already covered by normalization, rejects odd names, and keeps the file valid and readable', () => {
    const path = fresh();
    const before = readFileSync(path, 'utf8');
    const r = addDateFieldNames(path, ['Ord_Date', 'ORD DATE', 'Last-Revised', 'last_edit_date', '"; drop', '', 'x'.repeat(80)]);
    expect(r.added).toEqual(['Ord_Date', 'Last-Revised']);
    expect(r.skipped).toEqual(['ORD DATE', 'last_edit_date', '"; drop', '', 'x'.repeat(80)]);
    const after = readFileSync(path, 'utf8');
    const cfg = JSON.parse(after);
    expect(cfg.dateFieldNames).toEqual([...rawConfig.dateFieldNames, 'Ord_Date', 'Last-Revised']);
    expect(after.replace(/,\s*"Ord_Date", "Last-Revised"/, '')).toBe(before); // nothing else in the file changed
    expect(resolveConfig(cfg).dateFields.has(normalizeName('ord date'))).toBe(true);
  });

  it('adding nothing leaves the file untouched', () => {
    const path = fresh();
    const before = readFileSync(path, 'utf8');
    expect(addDateFieldNames(path, ['EditDate']).added).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('through the API; the next check uses the new name without a restart', async () => {
    const path = fresh();
    const app = buildApp({ dbPath: ':memory:', configPath: path, allowPrivateHosts: true });
    apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/api/config/date-fields', payload: { names: ['Ord_Date'] } });
    expect(r.json().added).toEqual(['Ord_Date']);
    expect((await app.inject({ url: '/api/config' })).json().config.dateFieldNames).toContain('Ord_Date');
    expect((await app.inject({ method: 'POST', url: '/api/config/date-fields', payload: { names: [] } })).statusCode).toBe(400);
  });
});

beforeEach(() => {
  google.tokenCalls.length = 0;
});
