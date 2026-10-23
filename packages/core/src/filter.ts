/** Results-table filters (PRD 10.5): summary card, city, status, issue code, state, date range, older than N years, no date, free text. */
import { ageYears } from './freshness';
import { isFailure } from './issues';
import type { CheckResult, CheckRow } from './types';

export type CardFilter = 'all' | 'checked' | 'passed' | 'nodate' | 'issues' | 'pending';

export interface Filters {
  card: CardFilter;
  /** `${city}|${state}` lower-cased, as produced by cityKey(). */
  city: string | null;
  text: string;
  /** Exact status, or '' for any. */
  status: string;
  /** Any issue code on the row (status or warning), or '' for any. */
  code: string;
  state: string;
  dateFrom: string;
  dateTo: string;
  /** 0 / null = off. */
  olderThanYears: number | null;
  noDate: boolean;
}

export const NO_FILTERS: Filters = { card: 'all', city: null, text: '', status: '', code: '', state: '', dateFrom: '', dateTo: '', olderThanYears: null, noDate: false };

export const cityKey = (row: Pick<CheckRow, 'city' | 'state'>) => `${row.city.toLowerCase()}|${row.state.toLowerCase()}`;

export interface DisplayRow {
  row: CheckRow;
  result?: CheckResult;
}

export function isFiltered(f: Filters): boolean {
  return JSON.stringify(f) !== JSON.stringify(NO_FILTERS);
}

export function applyFilters(rows: CheckRow[], results: Record<string, CheckResult>, f: Filters, now = new Date()): DisplayRow[] {
  const q = f.text.trim().toLowerCase();
  const out: DisplayRow[] = [];
  for (const row of rows) {
    const result = results[row.id];
    const st = result?.status;
    if (f.city && cityKey(row) !== f.city) continue;
    const cardOk = {
      all: true,
      checked: !!result,
      passed: st === 'OK',
      nodate: st === 'OK_NO_DATE',
      issues: !!st && isFailure(st),
      pending: !result,
    }[f.card];
    if (!cardOk) continue;
    if (f.state && row.state.toLowerCase() !== f.state.toLowerCase()) continue;
    if (f.status && (st ?? 'PENDING') !== f.status) continue;
    if (f.code && !result?.issues.some((i) => i.code === f.code)) continue;

    const hasDate = !!result && /^\d{4}-\d{2}-\d{2}$/.test(result.primaryDate);
    if (f.noDate && hasDate) continue;
    if (f.dateFrom || f.dateTo || f.olderThanYears) {
      if (!hasDate) continue; // a date-based filter can only match rows that have a date
      const d = result!.primaryDate;
      if (f.dateFrom && d < f.dateFrom) continue;
      if (f.dateTo && d > f.dateTo) continue;
      if (f.olderThanYears && ageYears(d, now) <= f.olderThanYears) continue;
    }
    if (q) {
      const hay = `${row.city} ${row.state} ${row.county} ${row.url} ${st ?? 'pending'} ${result?.issues.map((i) => i.code).join(' ') ?? ''} ${result?.issueReason ?? ''} ${result?.primaryDate ?? ''} ${result?.reviewer ?? ''} ${result?.analystNote ?? ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push({ row, result });
  }
  return out;
}
