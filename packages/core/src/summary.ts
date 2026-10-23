/** Summary cards and the per-city issue panel (PRD 10.2, 10.3, 12). */
import { isFailure } from './issues';
import type { CheckResult, CheckRow, IssueNote } from './types';

export interface Summary {
  total: number;
  checked: number;
  /** Status OK */
  passed: number;
  /** Status OK_NO_DATE */
  okNoDate: number;
  /** Status is a failure code. Warnings alone do not count. */
  issues: number;
  pending: number;
}

export function summarize(rows: CheckRow[], results: Map<string, CheckResult> | Record<string, CheckResult>): Summary {
  const get = (id: string) => (results instanceof Map ? results.get(id) : results[id]);
  const s: Summary = { total: rows.length, checked: 0, passed: 0, okNoDate: 0, issues: 0, pending: 0 };
  for (const row of rows) {
    const r = get(row.id);
    if (!r) {
      s.pending++;
      continue;
    }
    s.checked++;
    if (r.status === 'OK') s.passed++;
    else if (r.status === 'OK_NO_DATE') s.okNoDate++;
    else if (isFailure(r.status)) s.issues++;
  }
  return s;
}

export interface CityIssue extends IssueNote {
  rowId: string;
  url: string;
}

export interface CityGroup {
  key: string;
  city: string;
  state: string;
  maps: number;
  checked: number;
  /** Maps whose status is a failure. */
  issues: number;
  /** Every issue on every map in this city, including warnings and OK_NO_DATE. */
  issueList: CityIssue[];
}

export function groupByCity(rows: CheckRow[], results: Map<string, CheckResult> | Record<string, CheckResult>): CityGroup[] {
  const get = (id: string) => (results instanceof Map ? results.get(id) : results[id]);
  const groups = new Map<string, CityGroup>();
  for (const row of rows) {
    const key = `${row.city.toLowerCase()}|${row.state.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, city: row.city || '(no city)', state: row.state, maps: 0, checked: 0, issues: 0, issueList: [] };
      groups.set(key, g);
    }
    g.maps++;
    const r = get(row.id);
    if (!r) continue;
    g.checked++;
    if (isFailure(r.status)) g.issues++;
    for (const i of r.issues) g.issueList.push({ ...i, rowId: row.id, url: row.url });
  }
  return [...groups.values()].sort((a, b) => b.issues - a.issues || a.city.localeCompare(b.city));
}
