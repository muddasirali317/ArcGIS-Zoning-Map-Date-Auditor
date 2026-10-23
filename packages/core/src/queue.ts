/**
 * Async work queue (PRD 8): global concurrency cap, per-host cap, hosts interleaved
 * round-robin so one slow server cannot block the rest, plus pause / resume / cancel.
 */
import { AbortedError } from './http';

export interface QueueItem {
  id: string;
  /** Grouping key for the per-host limit. */
  host: string;
}

export type QueueState = 'idle' | 'running' | 'paused' | 'done' | 'cancelled';

export interface QueueStats {
  state: QueueState;
  total: number;
  completed: number;
  active: number;
  pending: number;
  /** Items that threw instead of returning a result. Should always be 0. */
  unhandled: number;
  /** Highest concurrency seen, for verifying the limits. */
  peakActive: number;
  peakActivePerHost: number;
}

export interface QueueOptions<I extends QueueItem, R> {
  globalConcurrency: number;
  perHost: number;
  onResult: (item: I, result: R) => void;
  onUnhandled?: (item: I, error: unknown) => void;
  /** Called after every state or count change. */
  onChange?: (stats: QueueStats) => void;
}

export class RunQueue<I extends QueueItem, R> {
  private hostOrder: string[] = [];
  private pendingByHost = new Map<string, I[]>();
  private activeByHost = new Map<string, number>();
  private cursor = 0;
  private active = 0;
  private completed = 0;
  private unhandled = 0;
  private peakActive = 0;
  private peakActivePerHost = 0;
  private state: QueueState = 'idle';
  private controller = new AbortController();
  private resolveFinished!: (s: 'done' | 'cancelled') => void;
  /** Resolves when everything has completed, or after cancel() once in-flight work has stopped. */
  readonly finished: Promise<'done' | 'cancelled'> = new Promise((r) => (this.resolveFinished = r));
  private readonly total: number;

  constructor(
    items: I[],
    private worker: (item: I, signal: AbortSignal) => Promise<R>,
    private opts: QueueOptions<I, R>,
  ) {
    this.total = items.length;
    for (const item of items) {
      let list = this.pendingByHost.get(item.host);
      if (!list) {
        list = [];
        this.pendingByHost.set(item.host, list);
        this.hostOrder.push(item.host);
      }
      list.push(item);
    }
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'running';
    if (this.total === 0) return this.finish('done');
    this.pump();
  }

  pause(): void {
    if (this.state === 'running') {
      this.state = 'paused';
      this.changed();
    }
  }

  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running';
      this.pump();
    }
  }

  cancel(): void {
    if (this.state === 'done' || this.state === 'cancelled') return;
    this.state = 'cancelled';
    this.controller.abort();
    this.changed();
    if (this.active === 0) this.resolveFinished('cancelled');
  }

  stats(): QueueStats {
    const pending = [...this.pendingByHost.values()].reduce((n, l) => n + l.length, 0);
    return {
      state: this.state,
      total: this.total,
      completed: this.completed,
      active: this.active,
      pending,
      unhandled: this.unhandled,
      peakActive: this.peakActive,
      peakActivePerHost: this.peakActivePerHost,
    };
  }

  /** Items never started (after cancel or while paused). */
  remaining(): I[] {
    return [...this.pendingByHost.values()].flat();
  }

  private changed() {
    this.opts.onChange?.(this.stats());
  }

  private finish(s: 'done' | 'cancelled') {
    this.state = s;
    this.changed();
    this.resolveFinished(s);
  }

  /** Next host, in round-robin order, that has work and spare per-host capacity. */
  private nextHost(): string | null {
    const n = this.hostOrder.length;
    for (let k = 0; k < n; k++) {
      const idx = (this.cursor + k) % n;
      const host = this.hostOrder[idx];
      if ((this.pendingByHost.get(host)?.length ?? 0) > 0 && (this.activeByHost.get(host) ?? 0) < this.opts.perHost) {
        this.cursor = (idx + 1) % n;
        return host;
      }
    }
    return null;
  }

  private pump() {
    while (this.state === 'running' && this.active < this.opts.globalConcurrency) {
      const host = this.nextHost();
      if (host === null) break;
      const item = this.pendingByHost.get(host)!.shift()!;
      this.launch(item);
    }
    this.changed();
  }

  private launch(item: I) {
    this.active++;
    const hostActive = (this.activeByHost.get(item.host) ?? 0) + 1;
    this.activeByHost.set(item.host, hostActive);
    this.peakActive = Math.max(this.peakActive, this.active);
    this.peakActivePerHost = Math.max(this.peakActivePerHost, hostActive);

    this.worker(item, this.controller.signal).then(
      (result) => this.settle(item, () => this.opts.onResult(item, result), true),
      (err) => {
        if (err instanceof AbortedError || this.controller.signal.aborted) return this.settle(item, () => undefined, false);
        this.unhandled++;
        this.settle(item, () => this.opts.onUnhandled?.(item, err), true);
      },
    );
  }

  private settle(item: I, notify: () => void, counted: boolean) {
    this.active--;
    this.activeByHost.set(item.host, (this.activeByHost.get(item.host) ?? 1) - 1);
    if (counted) this.completed++;
    try {
      notify();
    } catch {
      /* a failing listener must not stall the queue */
    }
    if (this.state === 'cancelled') {
      if (this.active === 0) this.resolveFinished('cancelled');
      return;
    }
    if (this.completed >= this.total) return this.finish('done');
    this.pump();
  }
}
