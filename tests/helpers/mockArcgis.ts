/** A local ArcGIS stand-in that counts hits per service, plus deterministic sheet rows pointing at it. */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { fingerprint, type CheckRow } from '@zoning/core';

export interface MockArcgis {
  origin: string;
  /** Requests for each service's root (`/svcN/MapServer?f=json`), by service path. */
  rootHits: Map<string, number>;
  totalHits: () => number;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Services: `/svcN/MapServer` loads and has a date (dated by N); `/tokN/MapServer` answers a
 * login-required error; `/deadN/...` never answers (to exercise timeouts).
 */
export async function startMockArcgis(opts: { port?: number; latencyMs?: number } = {}): Promise<MockArcgis> {
  const rootHits = new Map<string, number>();
  let total = 0;
  const sockets = new Set<Socket>();
  const latency = opts.latencyMs ?? 0;

  const server = http.createServer((req, res) => {
    total++;
    const url = new URL(req.url!, 'http://x');
    const m = /^\/(svc|tok|dead)(\d+)\/MapServer(?:\/(0)(\/query)?)?$/.exec(url.pathname);
    const respond = () => {
      if (!m) return json(res, { error: { code: 404, message: 'not found' } }, 404);
      const [, kind, n, layer, query] = m;
      if (kind === 'dead') return; // never answers
      if (!layer) rootHits.set(`/${kind}${n}`, (rootHits.get(`/${kind}${n}`) ?? 0) + 1);
      if (kind === 'tok') return json(res, { error: { code: 499, message: 'Token Required' } });
      if (query) return json(res, { features: [{ attributes: { max_d: Date.UTC(2020 + (Number(n) % 5), 3, 1 + (Number(n) % 27)), min_d: Date.UTC(2015, 0, 1), nn_count: 10 } }] });
      if (layer) return json(res, { id: 0, name: 'Zoning', type: 'Feature Layer', capabilities: 'Query', fields: [{ name: 'LastEditDate', type: 'esriFieldTypeDate' }] });
      return json(res, { currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }] });
    };
    if (latency) setTimeout(respond, latency);
    else respond();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    rootHits,
    totalHits: () => total,
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}

export function makeRows(origin: string, n: number, opts: { tokenEvery?: number; urlFor?: (i: number) => string } = {}): CheckRow[] {
  return Array.from({ length: n }, (_, i) => {
    const kind = opts.tokenEvery && (i + 1) % opts.tokenEvery === 0 ? 'tok' : 'svc';
    const url = opts.urlFor ? opts.urlFor(i) : `${origin}/${kind}${i}/MapServer`;
    const city = `City ${i}`;
    return { id: String(i + 2), sheetRow: i + 2, city, state: 'TX', county: '', url, fingerprint: fingerprint(city, 'TX', url), preIssues: [], extra: {} };
  });
}
