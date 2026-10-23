/** A run: the queue of rows being checked, plus the live event stream the UI subscribes to. */
import { randomUUID } from 'node:crypto';
import {
  checkMap,
  HostBreaker,
  isCacheable,
  normalizeUrl,
  rebrandResult,
  RunQueue,
  type CheckResult,
  type CheckRow,
  type Config,
  type HttpClient,
  type QueueItem,
  type QueueStats,
} from '@zoning/core';
import type { Store } from './db';

type Item = QueueItem & { row: CheckRow };

export type RunEvent =
  | { type: 'snapshot'; results: CheckResult[]; stats: QueueStats }
  | { type: 'result'; result: CheckResult }
  | { type: 'progress'; stats: QueueStats };

export interface RunOptions {
  /** Rows to check (already reduced by the sync plan). */
  rows: CheckRow[];
  http: HttpClient;
  config: Config;
  store: Store;
  sheetKey: string;
  /** Ignore the 24 h URL cache ("Force refresh", Re-check all / failed). */
  force?: boolean;
}

export class Run {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly results = new Map<string, CheckResult>();
  readonly breaker: HostBreaker;
  private subscribers = new Set<(e: RunEvent) => void>();
  private queue: RunQueue<Item, CheckResult>;
  private inflight = new Map<string, Promise<CheckResult>>();

  constructor(private o: RunOptions) {
    const { rows, http, config, store, sheetKey, force } = o;
    this.breaker = new HostBreaker(config.breakerThreshold);
    const ttlMs = config.cacheTtlHours * 3600_000;

    const items: Item[] = rows.map((row) => {
      const n = normalizeUrl(row.url);
      return { id: row.id, host: n.ok ? n.host : '(no host)', row };
    });

    this.queue = new RunQueue<Item, CheckResult>(
      items,
      async (item, signal) => {
        const row = item.row;
        const n = normalizeUrl(row.url);
        const canon = n.ok ? n.canonical : null;
        const now = new Date();
        if (canon && !force) {
          const cached = store.getCached(canon, ttlMs);
          if (cached) return rebrandResult(cached, row, now, { fromCache: true });
        }
        const check = () => checkMap(row, { http, config, signal, breaker: this.breaker });
        if (!canon) return check();
        // The same link in several rows is checked once; the other rows share the answer.
        let shared = this.inflight.get(canon);
        const first = !shared;
        if (!shared) this.inflight.set(canon, (shared = check()));
        const base = await shared;
        return first ? base : rebrandResult(base, row, now);
      },
      {
        globalConcurrency: config.concurrency.global,
        perHost: config.concurrency.perHost,
        onResult: (item, result) => {
          this.results.set(item.id, result);
          store.putResult(sheetKey, item.row.fingerprint, result); // saved immediately: survives a crash
          const n = normalizeUrl(item.row.url);
          if (n.ok && isCacheable(result) && !result.fromCache) store.putCached(n.canonical, result);
          this.emit({ type: 'result', result });
        },
        onUnhandled: (item, err) => console.error(`[run ${this.id}] unhandled error for row ${item.id}:`, err),
        onChange: (stats) => this.emit({ type: 'progress', stats }),
      },
    );
    this.queue.start();
  }

  get stats(): QueueStats {
    return this.queue.stats();
  }
  pause() {
    this.queue.pause();
  }
  resume() {
    this.queue.resume();
  }
  cancel() {
    this.queue.cancel();
  }
  get finished() {
    return this.queue.finished;
  }

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.subscribers.add(fn);
    fn({ type: 'snapshot', results: [...this.results.values()], stats: this.stats });
    return () => this.subscribers.delete(fn);
  }

  private emit(e: RunEvent) {
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch {
        this.subscribers.delete(fn);
      }
    }
  }
}

export class RunRegistry {
  private runs = new Map<string, Run>();
  create(o: RunOptions): Run {
    // Keep memory bounded: a finished run is only useful while its tab is open.
    for (const [id, r] of this.runs) if (['done', 'cancelled'].includes(r.stats.state) && Date.now() - r.startedAt > 6 * 3600_000) this.runs.delete(id);
    const run = new Run(o);
    this.runs.set(run.id, run);
    return run;
  }
  get(id: string): Run | undefined {
    return this.runs.get(id);
  }
}

