/**
 * Per-host circuit breaker (PRD 8). After `threshold` consecutive connection-level failures
 * (timeout, refused/reset, DNS, TLS) the host is skipped for the rest of the run, so one dead or
 * geo-blocked server cannot stall the queue. Any real HTTP answer, even a 404, proves the host is
 * reachable and resets the count.
 */
export class HostBreaker {
  private consecutive = new Map<string, number>();
  private lastReason = new Map<string, string>();
  private open = new Set<string>();

  constructor(readonly threshold = 5) {}

  recordSuccess(host: string): void {
    if (this.open.has(host)) return; // once open, stays open for this run
    this.consecutive.set(host, 0);
  }

  recordFailure(host: string, reason: string): void {
    if (this.open.has(host)) return;
    const n = (this.consecutive.get(host) ?? 0) + 1;
    this.consecutive.set(host, n);
    this.lastReason.set(host, reason);
    if (n >= this.threshold) this.open.add(host);
  }

  isOpen(host: string): boolean {
    return this.open.has(host);
  }

  describe(host: string): string {
    return `${host} failed ${this.threshold} connection attempts in a row (${this.lastReason.get(host) ?? 'no response'}), so the remaining maps on this server were skipped.`;
  }

  openHosts(): string[] {
    return [...this.open];
  }
}
