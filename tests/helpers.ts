import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError, resolveConfig, type CheckRow, type Config, type HttpClient, type HttpResponse, type RawConfig } from '@zoning/core';

const ROOT = resolve(__dirname, '..');

export const rawConfig: RawConfig = JSON.parse(readFileSync(resolve(ROOT, 'config/config.json'), 'utf8'));

/** Real config, but with tiny retry delays so tests do not wait. */
export function testConfig(over: Partial<RawConfig> = {}): Config {
  return resolveConfig({ ...rawConfig, retries: { max: 2, baseDelayMs: 1, maxDelayMs: 3 }, ...over });
}

export function fixture(name: string): any {
  return JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures', name), 'utf8'));
}

export const NOW = new Date('2026-12-01T12:00:00Z');
export const fixedNow = () => NOW;
export const noSleep = async () => {};

export function reply(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers }, body: text, url: '', ms: 5 };
}

export type Handler = (url: string, call: number) => HttpResponse | Promise<HttpResponse> | HttpError | Error;

/** Routes are matched in order against the full request URL. Unmatched requests return a 404 HTML page. */
export class MockHttp implements HttpClient {
  calls: string[] = [];
  private counts = new Map<number, number>();
  constructor(private routes: [RegExp | ((url: string) => boolean), Handler][]) {}
  async get(url: string): Promise<HttpResponse> {
    this.calls.push(url);
    for (let i = 0; i < this.routes.length; i++) {
      const [m, h] = this.routes[i];
      if (typeof m === 'function' ? m(url) : m.test(url)) {
        const n = (this.counts.get(i) ?? 0) + 1;
        this.counts.set(i, n);
        const out = await h(url, n);
        if (out instanceof Error) throw out;
        return out;
      }
    }
    return reply('<html><body>Not Found</body></html>', 404);
  }
}

export function row(url: string, over: Partial<CheckRow> = {}): CheckRow {
  return { id: '2', sheetRow: 2, city: 'Testville', state: 'TX', county: 'Test County', url, fingerprint: 'f', preIssues: [], extra: {}, ...over };
}

/** Small seeded PRNG so the load test is repeatable. */
export function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SVC = 'https://gis.testville.gov/arcgis/rest/services/Planning/Zoning/MapServer';

/** A minimal ArcGIS MapServer: one zoning layer with a single Date field. */
export function zoningService(opts: { fieldName?: string; fieldType?: string; statsMax?: number | null; statsMin?: number | null; editingInfo?: any; extraLayerFields?: any[] } = {}) {
  const field = opts.fieldName ?? 'LAST_EDIT_DATE';
  const root = { currentVersion: 10.9, serviceDescription: 'Zoning', capabilities: 'Map,Query,Data', layers: [{ id: 0, name: 'Zoning Districts', parentLayerId: -1, subLayerIds: null }], ...(opts.editingInfo ? { editingInfo: opts.editingInfo } : {}) };
  const layer = {
    currentVersion: 10.9, id: 0, name: 'Zoning Districts', type: 'Feature Layer', geometryType: 'esriGeometryPolygon', capabilities: 'Map,Query,Data', maxRecordCount: 1000,
    advancedQueryCapabilities: { supportsStatistics: true },
    fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: field, type: opts.fieldType ?? 'esriFieldTypeDate' }, ...(opts.extraLayerFields ?? [])],
  };
  const stats = { features: [{ attributes: { max_d: opts.statsMax === undefined ? Date.UTC(2023, 4, 14, 16, 30) : opts.statsMax, min_d: opts.statsMin === undefined ? Date.UTC(2019, 0, 3) : opts.statsMin, nn_count: 120 } }] };
  return new MockHttp([
    [/\/query\?/, () => reply(stats)],
    [/\/MapServer\/0\?f=json$/, () => reply(layer)],
    [/\/MapServer\?f=json$/, () => reply(root)],
  ]);
}
