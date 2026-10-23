/**
 * Phase 2: re-sync diffing (12.6), resume after a killed process (12.5), URL cache, de-duplication,
 * circuit breaker, persistence, filters, legend, freshness.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyFilters, checkMap, extentToLatLngBounds, flagDuplicates, freshness, HostBreaker, HttpError, mapServerLegend, NO_FILTERS,
  planSync, rendererToLegend, symbolToEntry, type CheckResult, type CheckRow, type SyncMode,
} from '@zoning/core';
import { buildApp } from '../apps/server/src/app';
import { Store } from '../apps/server/src/db';
import { fixedNow, fixture, MockHttp, noSleep, rawConfig, reply, row, testConfig } from './helpers';
import { makeRows, startMockArcgis, type MockArcgis } from './helpers/mockArcgis';

const ROOT = resolve(__dirname, '..');
let tmp: string;
let mock: MockArcgis;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'zoning-p2-'));
  mock = await startMockArcgis();
});
afterAll(async () => {
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** A config file with fast timeouts and room for many requests to one host. */
function configFile(over: Record<string, unknown> = {}): string {
  const path = join(tmp, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ ...rawConfig, concurrency: { global: 20, perHost: 20 }, retries: { max: 0, baseDelayMs: 1, maxDelayMs: 2 }, timeouts: { connectMs: 300, totalMs: 400 }, ...over }));
  return path;
}

function newApp(dbPath = ':memory:', config = configFile()) {
  const app = buildApp({ dbPath, configPath: config, allowPrivateHosts: true });
  apps.push(app);
  return app;
}

async function sync(app: FastifyInstance, sheetKey: string, rows: CheckRow[], mode: SyncMode = 'changed') {
  const res = await app.inject({ method: 'POST', url: '/api/sync', payload: { sheetKey, sheetUrl: 'x', rows, mode } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { runId: string | null; counts: Record<string, number>; results: CheckResult[]; removed: { row: CheckRow; result: CheckResult | null }[] };
  let run: { results: CheckResult[]; openHosts: string[] } | null = null;
  if (body.runId) {
    for (;;) {
      const snap = (await app.inject({ url: `/api/runs/${body.runId}` })).json();
      if (snap.stats.state === 'done') {
        run = snap;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  return { ...body, run };
}

describe('re-sync (PRD 12.6)', () => {
  it('changing 5 of 60 rows queues exactly those 5; the rest are carried over with no requests', async () => {
    const app = newApp();
    const rows = makeRows(mock.origin, 60);
    const first = await sync(app, 'resync:0', rows);
    expect(first.counts).toMatchObject({ total: 60, queued: 60, unchanged: 0 });
    expect(first.run!.results).toHaveLength(60);
    const hitsBefore = mock.totalHits();

    const edited = rows.map((r, i) => {
      if (i < 10 || i >= 15) return r;
      const url = `${mock.origin}/svc${1000 + i}/MapServer`; // 5 rows get a new link
      return { ...r, url, fingerprint: r.fingerprint + 'x' + i };
    });
    const second = await sync(app, 'resync:0', edited);

    expect(second.counts).toMatchObject({ total: 60, queued: 5, changed: 5, added: 0, unchanged: 55 });
    expect(second.results).toHaveLength(55); // stored results shown immediately
    expect(second.run!.results.map((r) => r.id).sort()).toEqual(['12', '13', '14', '15', '16']);
    // 5 rows x (root + layer + stats) = 15 requests, and nothing else
    expect(mock.totalHits() - hitsBefore).toBe(15);
    expect(mock.rootHits.get('/svc1010')).toBe(1);
    expect(mock.rootHits.get('/svc3')).toBe(1); // unchanged row was not requested again
  });

  it('a row inserted at the top shifts every sheet row number but re-queues only the new row', async () => {
    const app = newApp();
    const rows = makeRows(mock.origin, 30);
    await sync(app, 'shift:0', rows);
    const fresh = makeRows(mock.origin, 1, { urlFor: () => `${mock.origin}/svc9001/MapServer` })[0];
    const shifted = [fresh, ...rows].map((r, i) => ({ ...r, id: String(i + 2), sheetRow: i + 2 }));
    const res = await sync(app, 'shift:0', shifted);
    expect(res.counts.queued).toBe(1);
    expect(res.results).toHaveLength(30);
    expect(res.results.find((r) => r.city === 'City 0')!.id).toBe('3'); // carried result follows its row to the new position
  });

  it('rows removed from the sheet are marked removed (with their result), never silently deleted, and come back if re-added', async () => {
    const app = newApp();
    const rows = makeRows(mock.origin, 20);
    await sync(app, 'rm:0', rows);
    const res = await sync(app, 'rm:0', rows.slice(0, 18));
    expect(res.counts).toMatchObject({ queued: 0, removed: 2 });
    expect(res.removed.map((x) => x.row.city).sort()).toEqual(['City 18', 'City 19']);
    expect(res.removed.every((x) => x.result?.status === 'OK')).toBe(true);
    const state = (await app.inject({ url: '/api/state?sheetKey=rm:0' })).json();
    expect(state.removed).toHaveLength(2);
    const back = await sync(app, 'rm:0', rows);
    expect(back.counts.removed).toBe(0);
    expect(back.counts.queued).toBe(0); // their stored results are reused
  });

  it('modes: failed re-queues only failures; all re-queues everything and bypasses the cache', async () => {
    const app = newApp();
    const rows = makeRows(mock.origin, 40, { tokenEvery: 10 }); // 4 secured
    const first = await sync(app, 'modes:0', rows);
    expect(first.run!.results.filter((r) => r.status === 'TOKEN_REQUIRED')).toHaveLength(4);

    expect((await sync(app, 'modes:0', rows, 'changed')).counts.queued).toBe(0);
    expect((await sync(app, 'modes:0', rows, 'failed')).counts.queued).toBe(4);
    const hits = mock.totalHits();
    const all = await sync(app, 'modes:0', rows, 'all');
    expect(all.counts.queued).toBe(40);
    expect(mock.totalHits() - hits).toBeGreaterThanOrEqual(40 * 3 - 4 * 2); // really re-requested, not served from the cache
    expect(all.run!.results.every((r) => !r.fromCache)).toBe(true);
  });

  it('planSync is pure and matches by fingerprint', () => {
    const mk = (id: string, fp: string): CheckRow => ({ ...row('https://a.gov/x/MapServer'), id, fingerprint: fp });
    const prev = [mk('2', 'a'), mk('3', 'b'), mk('4', 'c')];
    const next = [mk('2', 'a'), mk('3', 'b2'), mk('5', 'd')];
    const stored = new Map<string, CheckResult>([['a', { status: 'OK' } as CheckResult], ['b', { status: 'OK' } as CheckResult], ['c', { status: 'TIMEOUT' } as CheckResult]]);
    const p = planSync(prev, next, stored, 'changed');
    expect(p.unchanged.map((r) => r.id)).toEqual(['2']);
    expect(p.changed.map((r) => r.id)).toEqual(['3']);
    expect(p.added.map((r) => r.id)).toEqual(['5']);
    expect(p.removed.map((r) => r.fingerprint).sort()).toEqual(['b', 'c']);
    expect(p.toCheck.map((r) => r.id)).toEqual(['3', '5']);
  });
});

describe('resume after the process is killed (PRD 12.5)', () => {
  it('kill -9 at ~40%, restart: no completed row is requested again, none is lost, none is duplicated', async () => {
    const N = 120;
    const slow = await startMockArcgis({ latencyMs: 110 });
    const dbPath = join(tmp, 'crash.db');
    const config = configFile();
    const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tests/helpers/crash-child.ts'), dbPath, config, slow.origin, String(N)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));

    const progress = () => Math.max(0, ...[...out.matchAll(/PROGRESS (\d+)/g)].map((m) => Number(m[1])));
    const started = Date.now();
    while (progress() < N * 0.4) {
      if (Date.now() - started > 60_000) throw new Error(`child never reached 40%: ${out.slice(-200)} ${err.slice(-500)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    // What survived on disk.
    const peek = new Store(dbPath);
    const survived = peek.getResults('crash:0');
    peek.close();
    expect(survived.size).toBeGreaterThanOrEqual(N * 0.4);
    expect(survived.size).toBeLessThan(N); // it really was interrupted
    const hitsAtCrash = new Map(slow.rootHits);

    // Restart on the same database and sync again.
    const app = newApp(dbPath, config);
    const rows = makeRows(slow.origin, N);
    const res = await sync(app, 'crash:0', rows);
    expect(res.counts.unchanged).toBe(survived.size);
    expect(res.counts.queued).toBe(N - survived.size);
    expect(res.results).toHaveLength(survived.size);

    // Nothing lost, nothing duplicated.
    const after = new Store(dbPath);
    const final = after.getResults('crash:0');
    after.close();
    expect(final.size).toBe(N);
    expect(new Set(rows.map((r) => r.fingerprint))).toEqual(new Set(final.keys()));
    expect([...final.values()].every((r) => r.status === 'OK')).toBe(true);

    // Rows finished before the kill were not fetched again after the restart.
    for (const [fp, r] of survived) {
      const path = `/svc${Number(r.id) - 2}`;
      expect(slow.rootHits.get(path), `${path} (${fp})`).toBe(hitsAtCrash.get(path));
    }
    console.log(`[resume] killed with ${survived.size}/${N} stored; restart queued ${res.counts.queued}; no stored row re-requested`);
    await slow.close();
  }, 120_000);
});

describe('URL cache and duplicate links', () => {
  it('the same URLs on another sheet are served from the 24 h cache with no requests; failures are not cached', async () => {
    const app = newApp();
    const rows = makeRows(mock.origin, 20, { tokenEvery: 10, urlFor: (i) => `${mock.origin}/${(i + 1) % 10 === 0 ? 'tok' : 'svc'}${2000 + i}/MapServer` });
    await sync(app, 'cacheA:0', rows);
    const before = mock.totalHits();
    const b = await sync(app, 'cacheB:0', rows);
    const cached = b.run!.results.filter((r) => r.fromCache);
    expect(cached).toHaveLength(18);
    expect(cached.every((r) => r.status === 'OK')).toBe(true);
    expect(b.run!.results.filter((r) => r.status === 'TOKEN_REQUIRED' && !r.fromCache)).toHaveLength(2); // re-checked: failures may be temporary
    expect(mock.totalHits() - before).toBe(2); // one request per secured service, none for the 18 cached
  });

  it('cache entries expire after the configured TTL', () => {
    const store = new Store(':memory:');
    store.putCached('https://a.gov/x/mapserver', { status: 'OK' } as CheckResult, 1_000);
    expect(store.getCached('https://a.gov/x/mapserver', 5_000, 3_000)).not.toBeNull();
    expect(store.getCached('https://a.gov/x/mapserver', 5_000, 7_000)).toBeNull();
    store.close();
  });

  it('26 rows with the same link make one set of requests; each row still gets its own result and duplicate flag', async () => {
    const app = newApp();
    const url = `${mock.origin}/svc777/MapServer`;
    const rows = makeRows(mock.origin, 26, { urlFor: () => url });
    flagDuplicates(rows);
    const before = mock.totalHits();
    const res = await sync(app, 'dup:0', rows);
    expect(mock.totalHits() - before).toBe(3);
    expect(res.run!.results).toHaveLength(26);
    expect(new Set(res.run!.results.map((r) => r.city)).size).toBe(26);
    expect(res.run!.results.every((r) => r.status === 'OK' && r.issues.filter((i) => i.code === 'DUPLICATE_URL').length === 1)).toBe(true);
  });
});

describe('circuit breaker', () => {
  it('HostBreaker: trips after N consecutive failures, any answer resets the count', () => {
    const b = new HostBreaker(3);
    b.recordFailure('a', 'TIMEOUT');
    b.recordFailure('a', 'TIMEOUT');
    b.recordSuccess('a');
    b.recordFailure('a', 'TIMEOUT');
    b.recordFailure('a', 'TIMEOUT');
    expect(b.isOpen('a')).toBe(false);
    b.recordFailure('a', 'TIMEOUT');
    expect(b.isOpen('a')).toBe(true);
    expect(b.isOpen('other')).toBe(false);
    expect(b.describe('a')).toContain('3 connection attempts');
  });

  it('engine: after 5 connection failures the rest of that host is skipped with HOST_UNREACHABLE; other hosts are unaffected', async () => {
    const breaker = new HostBreaker(5);
    const http = new MockHttp([
      [/dead\.gov/, () => new HttpError('TIMEOUT', 'x')],
      [/./, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Z' }], fields: [] })],
    ]);
    const cfg = testConfig({ retries: { max: 0, baseDelayMs: 1, maxDelayMs: 1 } });
    const results = [];
    for (let i = 0; i < 20; i++) results.push(await checkMap(row(`https://gis.dead.gov/rest/s${i}/MapServer`, { id: String(i) }), { http, config: cfg, now: fixedNow, sleep: noSleep, breaker }));
    const good = await checkMap(row('https://gis.fine.gov/rest/x/MapServer'), { http, config: cfg, now: fixedNow, sleep: noSleep, breaker });

    expect(results.filter((r) => r.status === 'TIMEOUT')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'HOST_UNREACHABLE')).toHaveLength(15);
    expect(http.calls.filter((u) => u.includes('dead.gov'))).toHaveLength(5); // 15 maps cost zero requests
    expect(results[19].issueReason).toContain('gis.dead.gov');
    expect(good.status).not.toBe('HOST_UNREACHABLE');
  });

  it('a retry in progress stops as soon as the host trips', async () => {
    const breaker = new HostBreaker(2);
    const http = new MockHttp([[/./, () => new HttpError('TIMEOUT', 'x')]]);
    const cfg = testConfig({ retries: { max: 5, baseDelayMs: 1, maxDelayMs: 1 } });
    const res = await checkMap(row('https://x.gov/a/MapServer'), { http, config: cfg, now: fixedNow, sleep: noSleep, breaker });
    expect(http.calls).toHaveLength(2);
    expect(res.status).toBe('HOST_UNREACHABLE');
  });

  it('through the server: a dead host costs a handful of timeouts, then "Re-check failed" retries the skipped rows', async () => {
    // perHost 3 as in the real config: rows go out in waves, so the breaker can trip before the rest start
    const app = newApp(':memory:', configFile({ breakerThreshold: 4, concurrency: { global: 20, perHost: 3 } }));
    const rows = makeRows(mock.origin, 24, { urlFor: (i) => `${mock.origin}/dead${i}/MapServer` });
    const before = mock.totalHits();
    const t0 = Date.now();
    const res = await sync(app, 'brk:0', rows);
    const statuses = res.run!.results.map((r) => r.status);
    expect(statuses.filter((s) => s === 'TIMEOUT').length).toBeGreaterThanOrEqual(4);
    expect(statuses.filter((s) => s === 'HOST_UNREACHABLE').length).toBeGreaterThanOrEqual(8);
    expect(mock.totalHits() - before).toBeLessThanOrEqual(12);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.run!.openHosts).toEqual([new URL(mock.origin).hostname]);

    const retry = await sync(app, 'brk:0', rows, 'failed');
    expect(retry.counts.queued).toBe(24); // skipped and timed-out rows are both failures
  });
});

describe('persistence of analyst edits', () => {
  it('reviewer, note and Mark as reviewed survive a restart and follow the row', async () => {
    const dbPath = join(tmp, 'edits.db');
    const rows = makeRows(mock.origin, 5);
    let app = newApp(dbPath);
    const first = await sync(app, 'edits:0', rows);
    const target = first.run!.results.find((r) => r.id === '4')!;
    const edited: CheckResult = { ...target, reviewer: 'Sam', analystNote: 'looks right', reviewDate: '2026-12-02', manualReview: true };
    const put = await app.inject({ method: 'PUT', url: '/api/results', payload: { sheetKey: 'edits:0', items: [{ fingerprint: rows[2].fingerprint, result: edited }] } });
    expect(put.json()).toEqual({ saved: 1 });
    await app.close();
    apps.length = 0;

    app = newApp(dbPath);
    const state = (await app.inject({ url: '/api/state?sheetKey=edits:0' })).json();
    const r = state.results.find((x: CheckResult) => x.id === '4');
    expect(r).toMatchObject({ reviewer: 'Sam', analystNote: 'looks right', reviewDate: '2026-12-02', manualReview: true });
    expect(state.rows).toHaveLength(5);

    // a later sync with unchanged rows keeps the edit
    const again = await sync(app, 'edits:0', rows);
    expect(again.counts.queued).toBe(0);
    expect(again.results.find((x) => x.id === '4')).toMatchObject({ reviewer: 'Sam', manualReview: true });
    expect((await app.inject({ url: '/api/state?sheetKey=nothing' })).statusCode).toBe(404);
  });
});

describe('filters (PRD 10.5)', () => {
  const mkRow = (id: string, city: string, state: string): CheckRow => ({ ...row(`https://${city}.gov/x/MapServer`), id, city, state, fingerprint: id });
  const mkRes = (id: string, status: CheckResult['status'], date: string, codes: string[] = []): CheckResult =>
    ({ id, status, primaryDate: date, issues: codes.map((c) => ({ code: c, reason: `reason ${c}` })), issueReason: codes.join(' '), reviewer: '', analystNote: '' }) as unknown as CheckResult;
  const rows = [mkRow('1', 'Austin', 'TX'), mkRow('2', 'Dallas', 'TX'), mkRow('3', 'Tulsa', 'OK'), mkRow('4', 'Reno', 'NV'), mkRow('5', 'Provo', 'UT')];
  const now = new Date('2026-12-01T12:00:00');
  const results: Record<string, CheckResult> = {
    '1': mkRes('1', 'OK', '2026-06-01'),
    '2': mkRes('2', 'OK', '2019-03-01', ['DATE_IN_FUTURE']),
    '3': mkRes('3', 'OK_NO_DATE', 'None', ['OK_NO_DATE']),
    '4': mkRes('4', 'TIMEOUT', 'None', ['TIMEOUT']),
  };
  const ids = (f: Partial<typeof NO_FILTERS>) => applyFilters(rows, results, { ...NO_FILTERS, ...f }, now).map((d) => d.row.id);

  it('summary cards', () => {
    expect(ids({})).toEqual(['1', '2', '3', '4', '5']);
    expect(ids({ card: 'checked' })).toEqual(['1', '2', '3', '4']);
    expect(ids({ card: 'passed' })).toEqual(['1', '2']);
    expect(ids({ card: 'nodate' })).toEqual(['3']);
    expect(ids({ card: 'issues' })).toEqual(['4']);
    expect(ids({ card: 'pending' })).toEqual(['5']);
  });
  it('status, issue code, state, city', () => {
    expect(ids({ status: 'TIMEOUT' })).toEqual(['4']);
    expect(ids({ status: 'PENDING' })).toEqual(['5']);
    expect(ids({ code: 'DATE_IN_FUTURE' })).toEqual(['2']);
    expect(ids({ state: 'tx' })).toEqual(['1', '2']);
    expect(ids({ city: 'tulsa|ok' })).toEqual(['3']);
  });
  it('date range, older than N years, no date', () => {
    expect(ids({ dateFrom: '2026-01-01' })).toEqual(['1']);
    expect(ids({ dateTo: '2020-01-01' })).toEqual(['2']);
    expect(ids({ olderThanYears: 5 })).toEqual(['2']);
    expect(ids({ olderThanYears: 0.5 })).toEqual(['1', '2']);
    expect(ids({ noDate: true })).toEqual(['3', '4', '5']);
  });
  it('free text searches city, URL, status, issue and notes', () => {
    expect(ids({ text: 'AUSTIN' })).toEqual(['1']);
    expect(ids({ text: 'timeout' })).toEqual(['4']);
    expect(ids({ text: 'pending' })).toEqual(['5']);
    expect(ids({ text: 'zzz' })).toEqual([]);
  });
  it('filters combine', () => {
    expect(ids({ state: 'TX', olderThanYears: 5 })).toEqual(['2']);
    expect(ids({ card: 'issues', state: 'TX' })).toEqual([]);
  });
});

describe('freshness colours (PRD 10.7)', () => {
  const now = new Date('2026-12-01T12:00:00');
  const cfg = rawConfig.freshness;
  it.each([
    ['2026-06-01', 'green'],
    ['2025-12-02', 'green'],
    ['2025-01-01', 'yellow'],
    ['2024-06-01', 'yellow'],
    ['2023-06-01', 'orange'],
    ['2022-01-01', 'orange'],
    ['2021-12-02', 'orange'],
    ['2019-01-01', 'red'],
    ['None', 'grey'],
    ['2027-03-01', 'green'],
  ])('%s is %s', (date, level) => {
    expect(freshness(date, cfg, now).level).toBe(level);
  });
  it('every colour is paired with text', () => {
    for (const d of ['2026-06-01', '2025-01-01', '2022-01-01', '2019-01-01', 'None']) expect(freshness(d, cfg, now).label.length).toBeGreaterThan(0);
  });
  it('thresholds are configurable', () => {
    expect(freshness('2025-01-01', { greenYears: 2, yellowYears: 4, orangeYears: 6 }, now).level).toBe('green');
  });
});

describe('legend and extent (PRD 10.6)', () => {
  it('builds legend entries from a real layer renderer', () => {
    const renderer = fixture('real/wildfire_layer0.json').drawingInfo.renderer;
    const entries = rendererToLegend(renderer);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => typeof e.label === 'string')).toBe(true);
    expect(entries.some((e) => e.color || e.image)).toBe(true);
  });

  it('handles simple, unique-value and class-break renderers', () => {
    const fill = { type: 'esriSFS', color: [255, 0, 0, 128], outline: { color: [0, 0, 0, 255] } };
    expect(rendererToLegend({ type: 'simple', symbol: fill, label: 'Parcels' })).toEqual([{ label: 'Parcels', shape: 'fill', color: 'rgba(255,0,0,0.5)', outline: 'rgba(0,0,0,1)' }]);
    const uv = rendererToLegend({ type: 'uniqueValue', uniqueValueInfos: [{ value: 'R1', label: 'Residential', symbol: fill }, { value: 'C1', symbol: fill }], defaultSymbol: fill, defaultLabel: 'Other' });
    expect(uv.map((e) => e.label)).toEqual(['Residential', 'C1', 'Other']);
    const cb = rendererToLegend({ type: 'classBreaks', classBreakInfos: [{ classMaxValue: 10, label: '0-10', symbol: fill }] });
    expect(cb).toHaveLength(1);
    expect(rendererToLegend(null)).toEqual([]);
    expect(rendererToLegend({ type: 'heatmap' })).toEqual([]);
  });

  it('picture symbols become data URLs, CIM symbols give a colour', () => {
    expect(symbolToEntry({ type: 'esriPMS', imageData: 'AAAA', contentType: 'image/png' }, 'x').image).toBe('data:image/png;base64,AAAA');
    const cim = { type: 'CIMSymbolReference', symbol: { type: 'CIMPolygonSymbol', symbolLayers: [{ type: 'CIMSolidFill', color: { type: 'CIMRGBColor', values: [10, 20, 30, 100] } }] } };
    expect(symbolToEntry(cim, 'z').color).toBe('rgba(10,20,30,1)');
  });

  it('reads the MapServer legend endpoint for one layer', () => {
    const json = { layers: [{ layerId: 3, legend: [{ label: 'Zone A', contentType: 'image/png', imageData: 'QQ==' }] }, { layerId: 4, legend: [] }] };
    expect(mapServerLegend(json, 3)).toEqual([{ label: 'Zone A', shape: 'fill', image: 'data:image/png;base64,QQ==' }]);
    expect(mapServerLegend(json, 9)).toEqual([]);
  });

  it('converts Web Mercator and WGS84 extents; leaves other projections to the server', () => {
    const wm = extentToLatLngBounds({ xmin: -10018754.17, ymin: 3503549.84, xmax: -10018754.17, ymax: 3503549.84, spatialReference: { wkid: 102100 } })!;
    expect(wm[0][1]).toBeCloseTo(-90, 1);
    expect(wm[0][0]).toBeCloseTo(30, 1);
    expect(extentToLatLngBounds({ xmin: -98, ymin: 30, xmax: -97, ymax: 31, spatialReference: { wkid: 4326 } })).toEqual([[30, -98], [31, -97]]);
    expect(extentToLatLngBounds({ xmin: 1, ymin: 2, xmax: 3, ymax: 4, spatialReference: { wkid: 2278 } })).toBeNull();
    expect(extentToLatLngBounds(null)).toBeNull();
  });
});
