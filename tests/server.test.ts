/**
 * Server integration tests: the real Node HTTP client against real local sockets (timeouts, redirects,
 * size cap, TLS failure, SSRF guard), and the HTTP API end to end with Server-Sent Events.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMap, HttpError, type CheckResult } from '@zoning/core';
import { buildApp } from '../apps/server/src/app';
import { createHttpClient, isPrivateAddress, mapNetworkError } from '../apps/server/src/http-client';
import { MockHttp, reply, row, testConfig } from './helpers';

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let origin = '';
let server: http.Server;
let sockets: Set<import('node:net').Socket>;

beforeAll(async () => {
  sockets = new Set();
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    switch (url.pathname) {
      case '/ok': return json(res, { currentVersion: 10.9, hello: 'world' });
      case '/missing': return json(res, { error: 'no' }, 404);
      case '/r1': res.writeHead(302, { location: '/r2' }); return res.end();
      case '/r2': res.writeHead(301, { location: '/ok' }); return res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      case '/slow': return void setTimeout(() => json(res, { late: true }), 3000);
      case '/big': res.writeHead(200, { 'content-type': 'application/json' }); return void res.end('x'.repeat(200_000));
      case '/gzip': {
        const { gzipSync } = require('node:zlib');
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return void res.end(gzipSync(JSON.stringify({ currentVersion: 10.9, zipped: true })));
      }
      case '/ratelimited': res.writeHead(429, { 'retry-after': '1' }); return res.end('slow down');
      case '/utf8': res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return void res.end(JSON.stringify({ name: 'Zoning – Résumé ✓' }));
      // A tiny ArcGIS MapServer used by the API end-to-end test.
      default: {
        const m = /^\/svc(\d+)\/MapServer(?:\/(0)(\/query)?)?$/.exec(url.pathname);
        if (!m) return json(res, { error: { code: 404, message: 'not found' } }, 404);
        const bad = Number(m[1]) % 5 === 0; // every 5th service is secured
        if (bad) return json(res, { error: { code: 499, message: 'Token Required' } });
        if (m[3]) return json(res, { features: [{ attributes: { max_d: Date.UTC(2023, 4, 14), min_d: Date.UTC(2020, 0, 1), nn_count: 10 } }] });
        if (m[2]) return json(res, { id: 0, name: 'Zoning', type: 'Feature Layer', capabilities: 'Query', fields: [{ name: 'LastEditDate', type: 'esriFieldTypeDate' }] });
        return json(res, { currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }] });
      }
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.destroy());
  await new Promise((r) => server.close(r));
});

const client = (over: Record<string, unknown> = {}) => createHttpClient({ connectMs: 2000, totalMs: 1500, maxBytes: 100_000, allowPrivateHosts: true, ...over });

describe('Node HTTP client', () => {
  it('returns status, headers, body and the final URL', async () => {
    const res = await client().get(`${origin}/ok`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).hello).toBe('world');
    expect(res.headers['content-type']).toContain('json');
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it('passes error statuses through for the classifier', async () => {
    expect((await client().get(`${origin}/missing`)).status).toBe(404);
    const r = await client().get(`${origin}/ratelimited`);
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
  });

  it('follows redirects and reports the final URL', async () => {
    const res = await client().get(`${origin}/r1`);
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${origin}/ok`);
  });

  it('a redirect loop is REDIRECT_LOOP', async () => {
    await expect(client().get(`${origin}/loop`)).rejects.toMatchObject({ code: 'REDIRECT_LOOP' });
  });

  it('a response slower than the total timeout is TIMEOUT', async () => {
    const t = performance.now();
    await expect(client({ totalMs: 1000 }).get(`${origin}/slow`)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(performance.now() - t).toBeLessThan(2500);
  });

  it('a response over the size cap is TOO_LARGE', async () => {
    await expect(client({ maxBytes: 10_000 }).get(`${origin}/big`)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('decompresses gzip and decodes UTF-8', async () => {
    expect(JSON.parse((await client().get(`${origin}/gzip`)).body).zipped).toBe(true);
    expect(JSON.parse((await client().get(`${origin}/utf8`)).body).name).toBe('Zoning – Résumé ✓');
  });

  it('a closed port is CONNECTION_FAILED', async () => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    await expect(client().get(`http://127.0.0.1:${port}/x`)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });

  it('an unresolvable domain is DNS_FAIL', async () => {
    await expect(client({ allowPrivateHosts: false }).get('https://zoning-auditor-test.invalid/x')).rejects.toMatchObject({ code: 'DNS_FAIL' });
  });

  it('speaking TLS to a plain HTTP port is SSL_ERROR', async () => {
    await expect(client().get(origin.replace('http:', 'https:') + '/ok')).rejects.toMatchObject({ code: 'SSL_ERROR' });
  });

  it('an external abort is rethrown as-is (the engine turns it into AbortedError, not a failure)', async () => {
    const ac = new AbortController();
    const p = client().get(`${origin}/slow`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.not.toBeInstanceOf(HttpError);
  });
});

describe('TLS certificate failures (real self-signed certificate)', () => {
  let dir: string;
  let tls: https.Server;
  let port: number;
  let ok = true;

  beforeAll(async () => {
    try {
      dir = mkdtempSync(join(tmpdir(), 'zoning-tls-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
      tls = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (_q, res) => json(res, { currentVersion: 10.9 }));
      await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
      port = (tls.address() as AddressInfo).port;
    } catch {
      ok = false;
    }
  });
  afterAll(async () => {
    if (tls) await new Promise((r) => tls.close(r));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a self-signed certificate is SSL_ERROR, never silently trusted', async () => {
    if (!ok) return console.warn('openssl unavailable: skipped');
    await expect(client().get(`https://127.0.0.1:${port}/x`)).rejects.toMatchObject({ code: 'SSL_ERROR' });
  });

  it('mapNetworkError recognises the common certificate error codes', () => {
    for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) {
      const e = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
      expect(mapNetworkError(e).code, code).toBe('SSL_ERROR');
    }
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) expect(mapNetworkError(Object.assign(new Error('f'), { cause: { code } })).code).toBe('DNS_FAIL');
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ETIMEDOUT']) expect(mapNetworkError(Object.assign(new Error('f'), { cause: { code } })).code).toBe('TIMEOUT');
    for (const code of ['ECONNRESET', 'ECONNREFUSED']) expect(mapNetworkError(Object.assign(new Error('f'), { cause: { code } })).code).toBe('CONNECTION_FAILED');
  });
});

describe('SSRF guard', () => {
  const c = client({ allowPrivateHosts: false });

  it('refuses private, loopback and link-local targets without connecting', async () => {
    for (const u of [`${origin}/ok`, 'http://localhost/x', 'http://127.0.0.1/x', 'http://10.1.2.3/x', 'http://192.168.0.5/x', 'http://172.16.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://0.0.0.0/x', 'http://100.64.0.1/x', 'http://[::ffff:127.0.0.1]/x', 'http://[fd00::1]/x']) {
      await expect(c.get(u), u).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
    }
  });

  it('refuses non-http schemes', async () => {
    await expect(c.get('file:///etc/passwd')).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
    await expect(c.get('ftp://example.com/x')).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('classifies addresses correctly', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('the engine reports a private address as URL_MALFORMED', async () => {
    const res = await checkMap(row('http://10.0.0.5/arcgis/rest/services/Z/MapServer'), { http: c, config: testConfig() });
    expect(res.status).toBe('URL_MALFORMED');
    expect(res.issueReason).toContain('private or local');
  });
});

describe('real HTTP client + engine against a local ArcGIS stand-in', () => {
  it('reads a date over real sockets, and classifies a 499 sent with HTTP 200', async () => {
    const c = client({ totalMs: 5000 });
    const ok = await checkMap(row(`${origin}/svc1/MapServer`), { http: c, config: testConfig() });
    expect(ok).toMatchObject({ status: 'OK', primaryDate: '2023-05-14', dateSource: 'Attribute:LastEditDate' });
    const priv = await checkMap(row(`${origin}/svc5/MapServer`), { http: c, config: testConfig() });
    expect(priv.status).toBe('TOKEN_REQUIRED');
    const gone = await checkMap(row(`${origin}/nothing/MapServer`), { http: c, config: testConfig() });
    expect(gone.status).toBe('HTTP_404');
  });
});

describe('HTTP API', () => {
  const sheetCsv = (urls: string[]) => ['City,State,County,Map URL', ...urls.map((u, i) => `City${i},TX,C${i},${u}`)].join('\n');
  const SHEET = 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=9';

  it('POST /api/sheet reads the CSV, drops empty lines, and suggests the column mapping', async () => {
    const seen: string[] = [];
    const app = buildApp({ dbPath: ':memory:', http: { get: async (u) => (seen.push(u), reply(sheetCsv(['https://a.gov/x/MapServer', 'https://b.gov/y/MapServer']) + '\n,,,\n', 200, { 'content-type': 'text/csv' })) } });
    const res = await app.inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(seen).toEqual(['https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=9']);
    expect(body.gid).toBe('9');
    expect(body.table).toHaveLength(3);
    expect(body.mapping).toEqual({ city: 0, state: 1, county: 2, url: 3 });
    await app.close();
  });

  it('a private sheet returns the PRD message, a bad link returns 400, an empty tab explains the gid', async () => {
    const priv = buildApp({ dbPath: ':memory:', http: { get: async () => reply('<!DOCTYPE html><html><title>Sign in</title>') } });
    const r1 = await priv.inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET } });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error).toBe('Sheet is private. Share as "Anyone with the link" or sign in with Google.');
    const r2 = await priv.inject({ method: 'POST', url: '/api/sheet', payload: { url: 'https://example.com' } });
    expect(r2.statusCode).toBe(400);
    const empty = buildApp({ dbPath: ':memory:', http: { get: async () => reply('City,State\n', 200) } });
    const r3 = await empty.inject({ method: 'POST', url: '/api/sheet', payload: { url: SHEET } });
    expect(r3.statusCode).toBe(422);
    expect(r3.json().error).toContain('gid');
  });

  it('GET /api/config serves the editable config file', async () => {
    const app = buildApp({ dbPath: ':memory:' });
    const body = (await app.inject({ url: '/api/config' })).json();
    expect(body.config.dateFieldNames).toContain('Last_Edit_Date');
    expect(body.config.concurrency).toEqual({ global: 20, perHost: 3 });
  });

  it('runs 30 maps end to end and streams every result over SSE; pause / resume / cancel are accepted', async () => {
    const app = buildApp({ dbPath: ':memory:', allowPrivateHosts: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const rows = Array.from({ length: 30 }, (_, i) => row(`${origin}/svc${i + 1}/MapServer`, { id: String(i + 2), sheetRow: i + 2, city: `City ${i}` }));

    const created = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows }) })).json();
    expect(created.total).toBe(30);

    const sse = await fetch(`${base}/api/runs/${created.id}/events`);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const results = new Map<string, CheckResult>();
    let finalState = '';
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!ev || !data) continue;
        const d = JSON.parse(data);
        if (ev === 'snapshot') d.results.forEach((r: CheckResult) => results.set(r.id, r));
        if (ev === 'result') results.set(d.id, d);
        if (ev === 'progress' || ev === 'snapshot') {
          const st = ev === 'snapshot' ? d.stats : d;
          finalState = st.state;
          if (st.state === 'done') break outer;
        }
      }
    }
    await reader.cancel();

    expect(finalState).toBe('done');
    expect(results.size).toBe(30);
    const statuses = [...results.values()].map((r) => r.status);
    expect(statuses.filter((s) => s === 'OK')).toHaveLength(24);
    expect(statuses.filter((s) => s === 'TOKEN_REQUIRED')).toHaveLength(6); // svc5,10,...,30
    for (const r of results.values()) expect(r.reviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const snap = (await (await fetch(`${base}/api/runs/${created.id}`)).json()) as { results: unknown[] };
    expect(snap.results).toHaveLength(30);
    for (const action of ['pause', 'resume', 'cancel']) expect((await fetch(`${base}/api/runs/${created.id}/${action}`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/api/runs/nope/pause`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: [] }) })).status).toBe(400);
    await app.close();
  });
});

// Keep a reference so the unused-import checker does not drop it: MockHttp is exercised in other files.
void MockHttp;
