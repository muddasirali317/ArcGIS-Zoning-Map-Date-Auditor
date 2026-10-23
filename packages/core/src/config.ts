import type { DateKind } from './types';

/** Shape of config/config.json. */
export interface RawConfig {
  dateFieldNames: string[];
  datePriority: DateKind[];
  concurrency: { global: number; perHost: number };
  timeouts: { connectMs: number; totalMs: number };
  retries: { max: number; baseDelayMs: number; maxDelayMs: number };
  maxResponseBytes: number;
  cacheTtlHours: number;
  maxLayersPerMap: number;
  layerKeywords: string[];
  freshness: { greenYears: number; yellowYears: number; orangeYears: number };
  sentinelDates: string[];
  /**
   * `latest` (default): the Primary Date is the newest of the attribute max and the service's last edit date.
   * `priority`: the first source in datePriority that has a date wins.
   */
  dateSelection?: 'latest' | 'priority';
  /** Consecutive connection failures before a host is skipped. */
  breakerThreshold?: number;
  /** How many services behind one viewer link are checked, best zoning match first. */
  maxResolvedServices?: number;
}

export interface Config extends RawConfig {
  /** Normalized date field names (see normalizeName). */
  dateFields: Set<string>;
  sentinels: Set<string>;
  dateSelection: 'latest' | 'priority';
  breakerThreshold: number;
  maxResolvedServices: number;
}

/** Lowercase and drop underscores, spaces and hyphens, so `Last_Edit_Date` == `LASTEDITDATE`. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_\s-]/g, '');
}

export function resolveConfig(raw: RawConfig): Config {
  if (!raw || !Array.isArray(raw.dateFieldNames) || raw.dateFieldNames.length === 0) {
    throw new Error('config: dateFieldNames must be a non-empty array');
  }
  return {
    ...raw,
    dateFields: new Set(raw.dateFieldNames.map(normalizeName)),
    sentinels: new Set(raw.sentinelDates),
    dateSelection: raw.dateSelection ?? 'latest',
    breakerThreshold: raw.breakerThreshold ?? 5,
    maxResolvedServices: raw.maxResolvedServices ?? 3,
  };
}
