/**
 * Node HttpClient used by the engine. Responsibilities (PRD 8, 9):
 *  - connect timeout 8 s, total timeout 20 s (from config)
 *  - SSRF guard: http/https only, private / loopback / link-local addresses refused, redirects re-checked
 *  - response size cap
 *  - classify low-level network errors into HttpError codes
 *  - optional upstream proxy (UPSTREAM_PROXY), the way to reach geo-blocked cities from the server
 */
import dns from 'node:dns';
import net from 'node:net';
import { Agent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import { HttpError, type HttpClient, type HttpResponse } from '@zoning/core';

export interface HttpClientOptions {
  connectMs: number;
  totalMs: number;
  maxBytes: number;
  /** Tests only: allow loopback and private addresses. Never enable in normal use. */
  allowPrivateHosts?: boolean;
  /** e.g. http://127.0.0.1:8080. Requests go through it. */
  upstreamProxy?: string;
  maxRedirects?: number;
  userAgent?: string;
}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && ip.startsWith('192.0.0.')) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) {
      const tail = l.slice(7);
      if (net.isIP(tail) === 4) return isPrivateAddress(tail);
      return true; // hex-form IPv4-mapped: refuse rather than parse
    }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true; // not an IP at all: refuse
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) throw new HttpError('BLOCKED_HOST', `${host} is a local address`);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new HttpError('BLOCKED_HOST', `${host} is a private address`);
    return;
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (e) {
    throw mapNetworkError(e);
  }
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new HttpError('BLOCKED_HOST', `${host} resolves to a private address`);
}

const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'EAI_NODATA', 'EAI_FAIL', 'EAI_NONAME']);

/** Walks the `cause` chain (undici wraps everything in "fetch failed") and returns the matching HttpError. */
export function mapNetworkError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const chain: any[] = [];
  for (let e: any = err; e && chain.length < 6; e = e.cause) chain.push(e);
  if (chain.some((e) => e?.code === 'SSRF_BLOCKED')) return new HttpError('BLOCKED_HOST', chain.find((e) => e?.code === 'SSRF_BLOCKED').message);
  for (const e of chain) {
    const code = String(e?.code ?? '');
    if (TIMEOUT_CODES.has(code) || e?.name === 'TimeoutError') return new HttpError('TIMEOUT', e.message || code);
  }
  for (const e of chain) {
    const code = String(e?.code ?? '');
    if (DNS_CODES.has(code)) return new HttpError('DNS_FAIL', e.message || code);
  }
  for (const e of chain) {
    const code = String(e?.code ?? '');
    const msg = String(e?.message ?? '');
    if (/CERT|SSL|TLS|SELF_SIGNED|ISSUER|SIGNATURE|VERIFY|CHAIN|HOSTNAME_MISMATCH|ALTNAME/i.test(code) || (code === 'EPROTO' && /ssl|tls|cert/i.test(msg)) || /certificate|self.signed|ssl routines|tls/i.test(msg)) {
      return new HttpError('SSL_ERROR', code || msg);
    }
  }
  const last = chain[0];
  return new HttpError('CONNECTION_FAILED', String(chain.find((e) => e?.code)?.code ?? last?.message ?? 'connection failed'));
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function createHttpClient(opts: HttpClientOptions): HttpClient & { close(): Promise<void> } {
  const maxRedirects = opts.maxRedirects ?? 5;
  const connect: any = { timeout: opts.connectMs };
  if (!opts.allowPrivateHosts && !opts.upstreamProxy) {
    // Re-check at connection time, so a host that resolves to a private address after the pre-check is still refused.
    connect.lookup = (hostname: string, options: any, cb: any) => {
      dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const list = addrs as unknown as dns.LookupAddress[];
        if (list.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'SSRF_BLOCKED' }));
        if (options?.all) return cb(null, list);
        cb(null, list[0].address, list[0].family);
      });
    };
  }
  const agentOpts = { connect, headersTimeout: opts.totalMs, bodyTimeout: opts.totalMs, keepAliveTimeout: 10_000 };
  const dispatcher: Dispatcher = opts.upstreamProxy ? new ProxyAgent({ uri: opts.upstreamProxy, ...agentOpts }) : new Agent(agentOpts);

  return {
    async get(url, { signal } = {}): Promise<HttpResponse> {
      const started = performance.now();
      let current = url;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        let target: URL;
        try {
          target = new URL(current);
        } catch {
          throw new HttpError('BLOCKED_HOST', `invalid URL ${current}`);
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new HttpError('BLOCKED_HOST', `unsupported protocol ${target.protocol}`);
        if (!opts.allowPrivateHosts) await assertPublicHost(target.hostname);

        // The total budget is shared across redirects. AbortSignal.timeout needs an integer.
        const timeout = AbortSignal.timeout(Math.max(1000, Math.ceil(opts.totalMs - (performance.now() - started))));
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let res;
        try {
          res = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            dispatcher,
            signal: combined,
            headers: { 'user-agent': opts.userAgent ?? 'ZoningMapDateAuditor/0.1 (+metadata check)', accept: 'application/json, text/plain;q=0.8, */*;q=0.5' },
          });
        } catch (e) {
          if (signal?.aborted) throw e;
          throw mapNetworkError(e);
        }

        if (REDIRECTS.has(res.status) && res.headers.get('location')) {
          await res.body?.cancel().catch(() => undefined);
          try {
            current = new URL(res.headers.get('location')!, current).toString();
          } catch {
            throw new HttpError('REDIRECT_LOOP', 'invalid redirect target');
          }
          continue;
        }

        let body: string;
        try {
          body = await readCapped(res.body, opts.maxBytes, combined);
        } catch (e) {
          if (signal?.aborted) throw e;
          throw mapNetworkError(e);
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        return { status: res.status, headers, body, url: current, ms: performance.now() - started };
      }
      throw new HttpError('REDIRECT_LOOP', `more than ${maxRedirects} redirects`);
    },
    close: () => dispatcher.close(),
  };
}

async function readCapped(stream: { getReader(): any } | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let size = 0;
  let out = '';
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError('TOO_LARGE', `response exceeds ${maxBytes} bytes`);
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}
