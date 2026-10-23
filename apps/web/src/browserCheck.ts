/**
 * Re-check maps from inside the browser. A browser VPN extension reroutes only browser traffic, so the
 * Node backend cannot reach cities that block non-US visitors, but the browser can. This runs the same
 * engine as the server with fetch() instead. It only works for servers that send CORS headers
 * (ArcGIS Server normally does); otherwise the row is reported as CORS_BLOCKED.
 */
import { checkMap, HttpError, normalizeUrl, resolveConfig, RunQueue, type CheckResult, type CheckRow, type HttpClient, type QueueItem, type QueueStats, type RawConfig } from '@zoning/core';

export function createBrowserHttp(totalMs: number, maxBytes: number): HttpClient {
  return {
    async get(url, { signal } = {}) {
      const started = performance.now();
      const timeout = AbortSignal.timeout(totalMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetch(url, { signal: combined, redirect: 'follow', credentials: 'omit', headers: { accept: 'application/json' } });
      } catch (e) {
        if (signal?.aborted) throw e;
        if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') throw new HttpError('TIMEOUT', 'timed out');
        // The browser does not say whether it was CORS, DNS, TLS or a refused connection.
        throw new HttpError('CORS_BLOCKED', (e as Error)?.message ?? 'fetch failed');
      }
      const body = await res.text();
      if (body.length > maxBytes) throw new HttpError('TOO_LARGE', 'response too large');
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return { status: res.status, headers, body, url: res.url || url, ms: performance.now() - started };
    },
  };
}

type Item = QueueItem & { row: CheckRow };

export interface BrowserCheckHandle {
  cancel(): void;
  finished: Promise<void>;
}

export function recheckInBrowser(
  rows: CheckRow[],
  rawConfig: RawConfig,
  on: { result(r: CheckResult): void; progress(s: QueueStats): void },
): BrowserCheckHandle {
  const config = resolveConfig(rawConfig);
  const http = createBrowserHttp(config.timeouts.totalMs, config.maxResponseBytes);
  const items: Item[] = rows.map((row) => {
    const n = normalizeUrl(row.url);
    return { id: row.id, host: n.ok ? n.host : '(no host)', row };
  });
  const queue = new RunQueue<Item, CheckResult>(items, (item, signal) => checkMap(item.row, { http, config, signal, via: 'browser' }), {
    globalConcurrency: config.concurrency.global,
    perHost: config.concurrency.perHost,
    onResult: (_item, r) => on.result(r),
    onChange: on.progress,
  });
  queue.start();
  return { cancel: () => queue.cancel(), finished: queue.finished.then(() => undefined) };
}
