/**
 * PRD 12.4: 1,000 mocked endpoints with random latency and 10% failures; assert the time target
 * and zero unhandled errors. Latency is mocked and scaled down, so this proves the scheduler,
 * the limits and the error handling, not real network speed.
 */
import { describe, expect, it } from 'vitest';
import { checkMap, HttpError, RunQueue, normalizeUrl, type CheckResult, type CheckRow, type HttpClient, type HttpResponse, type QueueItem } from '@zoning/core';
import { fixedNow, reply, rng, row, testConfig } from './helpers';

const TARGET_MS = 5 * 60 * 1000;
const HOSTS = 150;

class LatencyHttp implements HttpClient {
  inFlight = 0;
  peakInFlight = 0;
  inFlightByHost = new Map<string, number>();
  peakByHost = 0;
  requests = 0;
  constructor(
    private rand: () => number,
    private failing: Map<string, 'timeout' | '404' | '499' | 'html'>,
    private latency: [number, number],
  ) {}

  async get(url: string): Promise<HttpResponse> {
    const u = new URL(url);
    this.requests++;
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const h = (this.inFlightByHost.get(u.host) ?? 0) + 1;
    this.inFlightByHost.set(u.host, h);
    this.peakByHost = Math.max(this.peakByHost, h);
    const ms = this.latency[0] + this.rand() * (this.latency[1] - this.latency[0]);
    try {
      await new Promise((r) => setTimeout(r, ms));
      const mode = this.failing.get(u.pathname.split('/MapServer')[0] + '@' + u.host);
      if (mode === 'timeout') throw new HttpError('TIMEOUT', 'mock timeout');
      if (mode === '404') return reply('<html>gone</html>', 404);
      if (mode === '499') return reply({ error: { code: 499, message: 'Token Required' } });
      if (mode === 'html') return reply('<html>City site</html>');
      const date = Date.UTC(2020 + Math.floor(this.rand() * 5), Math.floor(this.rand() * 12), 1 + Math.floor(this.rand() * 27));
      if (/\/query\?/.test(url)) return { ...reply({ features: [{ attributes: { max_d: date, min_d: date - 1e10, nn_count: 5 } }] }), ms };
      if (/\/MapServer\/\d+\?f=json/.test(url)) {
        const id = Number(/MapServer\/(\d+)/.exec(url)![1]);
        return { ...reply({ id, name: id === 0 ? 'Zoning' : `Other ${id}`, type: 'Feature Layer', capabilities: 'Query', fields: [{ name: 'LastEditDate', type: 'esriFieldTypeDate' }] }), ms };
      }
      return { ...reply({ currentVersion: 10.9, layers: [{ id: 1, name: 'Parcels' }, { id: 2, name: 'Streets' }, { id: 0, name: 'Zoning' }] }), ms };
    } finally {
      this.inFlight--;
      this.inFlightByHost.set(u.host, (this.inFlightByHost.get(u.host) ?? 1) - 1);
    }
  }
}

type Item = QueueItem & { row: CheckRow };

function makeRows(n: number, rand: () => number) {
  const rows: CheckRow[] = [];
  const failing = new Map<string, 'timeout' | '404' | '499' | 'html'>();
  const modes = ['timeout', '404', '499', 'html'] as const;
  for (let i = 0; i < n; i++) {
    const host = `gis.city${i % HOSTS}.gov`;
    const path = `/arcgis/rest/services/Z${i}`;
    const url = `https://${host}${path}/MapServer`;
    rows.push(row(url, { id: String(i + 2), sheetRow: i + 2, city: `City ${i % HOSTS}` }));
    if (rand() < 0.1) failing.set(`${path}@${host}`, modes[Math.floor(rand() * modes.length)]);
  }
  return { rows, failing };
}

function runAll(rows: CheckRow[], http: LatencyHttp, opts: { global?: number; perHost?: number } = {}) {
  const config = testConfig({ concurrency: { global: opts.global ?? 20, perHost: opts.perHost ?? 3 } });
  const results = new Map<string, CheckResult>();
  const items: Item[] = rows.map((r) => {
    const n = normalizeUrl(r.url);
    return { id: r.id, host: n.ok ? n.host : '(invalid)', row: r };
  });
  const queue = new RunQueue<Item, CheckResult>(items, (item, signal) => checkMap(item.row, { http, config, now: fixedNow, signal }), {
    globalConcurrency: config.concurrency.global,
    perHost: config.concurrency.perHost,
    onResult: (item, res) => results.set(item.id, res),
  });
  return { queue, results, items };
}

describe('load: 1,000 mocked endpoints, random latency, ~10% failures', () => {
  it('finishes inside the 5 minute target with every row resolved, no unhandled errors, and limits respected', async () => {
    const rand = rng(42);
    const { rows, failing } = makeRows(1000, rand);
    const http = new LatencyHttp(rand, failing, [5, 60]);
    const { queue, results } = runAll(rows, http);

    const t0 = performance.now();
    queue.start();
    expect(await queue.finished).toBe('done');
    const elapsed = performance.now() - t0;

    const stats = queue.stats();
    const byStatus: Record<string, number> = {};
    for (const r of results.values()) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    console.log(`[load] 1000 maps in ${(elapsed / 1000).toFixed(1)}s, ${http.requests} requests, peak ${http.peakInFlight} in flight, peak ${http.peakByHost} per host, statuses ${JSON.stringify(byStatus)}`);

    expect(elapsed).toBeLessThan(TARGET_MS);
    expect(stats.unhandled).toBe(0);
    expect(stats.completed).toBe(1000);
    expect(results.size).toBe(1000);
    expect(new Set(results.keys()).size).toBe(1000); // none repeated or lost
    expect(http.peakInFlight).toBeLessThanOrEqual(20);
    expect(http.peakByHost).toBeLessThanOrEqual(3);
    expect(stats.peakActive).toBeLessThanOrEqual(20);

    const failed = [...results.values()].filter((r) => !['OK', 'OK_NO_DATE'].includes(r.status)).length;
    expect(failed).toBeGreaterThan(50); // about 10% of 1000 were set to fail
    expect(failed).toBeLessThan(150);
    expect(byStatus.OK).toBe(1000 - failed); // everything else read a date
    for (const r of results.values()) expect(r.primaryDate).toMatch(/^(\d{4}-\d{2}-\d{2}|None)$/);
  }, TARGET_MS);

  it('hot host: 120 maps on 4 hosts never exceed 3 requests in flight per host, nor 20 overall', async () => {
    const rand = rng(11);
    const rows: CheckRow[] = Array.from({ length: 120 }, (_, i) => row(`https://gis.hot${i % 4}.gov/arcgis/rest/services/Z${i}/MapServer`, { id: String(i + 2) }));
    const http = new LatencyHttp(rand, new Map(), [5, 25]);
    const { queue, results } = runAll(rows, http);
    queue.start();
    await queue.finished;
    expect(results.size).toBe(120);
    expect(http.peakByHost).toBe(3); // reached, and never passed
    expect(http.peakInFlight).toBe(12); // 4 hosts x 3
    expect(queue.stats().peakActivePerHost).toBe(3);
  });

  it('is dominated by latency, not scheduler overhead: 20 workers cut the wall time roughly 20x vs one', async () => {
    const mk = () => {
      const rand = rng(7);
      const { rows, failing } = makeRows(60, rand);
      return { rows, http: new LatencyHttp(rand, failing, [20, 20]) };
    };
    const a = mk();
    const one = runAll(a.rows, a.http, { global: 1, perHost: 3 });
    let t = performance.now();
    one.queue.start();
    await one.queue.finished;
    const serial = performance.now() - t;

    const b = mk();
    const many = runAll(b.rows, b.http);
    t = performance.now();
    many.queue.start();
    await many.queue.finished;
    const parallel = performance.now() - t;
    console.log(`[load] 60 maps: ${serial.toFixed(0)}ms with 1 worker vs ${parallel.toFixed(0)}ms with 20`);
    expect(parallel * 5).toBeLessThan(serial);
  });
});

describe('queue behaviour', () => {
  const slow = (ms: number) => new LatencyHttp(rng(1), new Map(), [ms, ms]);

  it('interleaves hosts: the first wave touches as many different hosts as it can', async () => {
    const rows: CheckRow[] = [];
    for (let i = 0; i < 30; i++) rows.push(row(`https://a.gov/arcgis/rest/services/Z${i}/MapServer`, { id: `a${i}` }));
    for (let h = 0; h < 10; h++) rows.push(row(`https://h${h}.gov/arcgis/rest/services/Z/MapServer`, { id: `h${h}` }));
    const order: string[] = [];
    const http = slow(15);
    const orig = http.get.bind(http);
    http.get = async (u) => {
      if (/\/MapServer\?f=json$/.test(u)) order.push(new URL(u).host);
      return orig(u);
    };
    const { queue } = runAll(rows, http);
    queue.start();
    await queue.finished;
    const firstWave = new Set(order.slice(0, 11));
    expect(firstWave.size).toBeGreaterThanOrEqual(10); // 'a.gov' did not hog the first slots
  });

  it('pause stops new work, resume continues, nothing is lost', async () => {
    const rand = rng(3);
    const { rows } = makeRows(80, rand);
    const { queue, results } = runAll(rows, slow(10));
    queue.start();
    await new Promise((r) => setTimeout(r, 60));
    queue.pause();
    await new Promise((r) => setTimeout(r, 150)); // in-flight work drains
    const frozen = queue.stats();
    expect(frozen.state).toBe('paused');
    expect(frozen.active).toBe(0);
    expect(frozen.pending).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(queue.stats().completed).toBe(frozen.completed); // truly stopped
    queue.resume();
    expect(await queue.finished).toBe('done');
    expect(results.size).toBe(80);
  });

  it('cancel aborts in-flight work, keeps finished results, and leaves the rest as pending', async () => {
    const rand = rng(5);
    const { rows } = makeRows(200, rand);
    const { queue, results } = runAll(rows, slow(30));
    queue.start();
    const deadline = Date.now() + 5000;
    while (results.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(results.size).toBeGreaterThan(0);
    queue.cancel();
    expect(await queue.finished).toBe('cancelled');
    const s = queue.stats();
    expect(s.active).toBe(0);
    expect(s.unhandled).toBe(0);
    expect(results.size).toBe(s.completed);
    expect(results.size).toBeGreaterThan(0);
    expect(results.size).toBeLessThan(200);
    expect(results.size + queue.remaining().length).toBeLessThanOrEqual(200);
  });

  it('an empty queue finishes immediately', async () => {
    const { queue } = runAll([], slow(1));
    queue.start();
    expect(await queue.finished).toBe('done');
  });

  it('a worker that throws is counted as unhandled and does not stall the queue', async () => {
    const items: QueueItem[] = Array.from({ length: 10 }, (_, i) => ({ id: String(i), host: `h${i % 2}` }));
    const seen: string[] = [];
    const q = new RunQueue(items, async (it) => { if (it.id === '4') throw new Error('bug'); return it.id; }, {
      globalConcurrency: 3, perHost: 2, onResult: (_i, r: string) => seen.push(r),
    });
    q.start();
    await q.finished;
    expect(q.stats().unhandled).toBe(1);
    expect(seen).toHaveLength(9);
  });
});
