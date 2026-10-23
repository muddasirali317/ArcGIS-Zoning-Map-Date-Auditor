/** Focused CSV exports. UTF-8 with BOM, RFC 4180 quoting, ISO dates. */
import { isFailure, isLinkIssue } from './issues';
import type { CheckResult, CheckRow, IssueNote } from './types';

export const FULL_CSV_COLUMNS = [
  'City', 'County', 'State', 'Source Link', 'Endpoint', 'Feature Type', 'Primary Date', 'Review Date', 'Evidence URL', 'Issue', 'Issue 2',
] as const;

/**
 * Text that starts with = + - @ would run as a formula when the CSV is opened in Excel, and
 * layer names or notes come from outside servers. Such cells get a leading apostrophe.
 */
export function neutralizeFormula(v: string): string {
  if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) return `'${v}`;
  return v;
}

export function csvCell(value: unknown): string {
  const s = neutralizeFormula(value === null || value === undefined ? '' : String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** True when the check found a real date somewhere (not the literal "None" the engine writes when it found nothing). */
function hasRealDate(r: CheckResult): boolean {
  return !!r.primaryDate && r.primaryDate !== 'None';
}

/**
 * The date to publish for a row: the Primary Date when one was found, otherwise the Review Date.
 * A map with no date of any kind still gets a date the client sheet can use; the Issue columns say why.
 */
export function effectivePrimaryDate(r: CheckResult): string {
  return hasRealDate(r) ? r.primaryDate : r.reviewDate;
}

/**
 * "No date found" is a date outcome (the Review Date is used instead), not a problem to report, so it
 * never appears in an Issue cell. Everything else keeps its exact on-screen / server message.
 */
function reportableIssues(issues: IssueNote[]): IssueNote[] {
  return issues.filter((i) => i.code !== 'OK_NO_DATE');
}

/** The exact on-screen / server messages, split: `map` = problems once the link opened, `link` = the link never opening. */
function issueText(issues: IssueNote[], link: boolean): string {
  return reportableIssues(issues)
    .filter((i) => isLinkIssue(i.code) === link)
    .map((i) => i.reason)
    .filter(Boolean)
    .join(' | ');
}

/** Both kinds of problem (map-side and link-side) in a single cell, for the one-column sheet write-back. */
function oneIssueText(r: CheckResult): string {
  return reportableIssues(r.issues).map((i) => i.reason).filter(Boolean).join(' | ');
}

export function rowOf(r: CheckResult): unknown[] {
  return [
    r.city, r.county, r.state, r.sourceUrl, r.normalizedUrl, r.serviceType,
    effectivePrimaryDate(r), r.reviewDate, r.evidenceUrl,
    issueText(r.issues, false), issueText(r.issues, true),
  ];
}

/** Full export. Rows not yet checked are omitted; `results` should already be in sheet order. */
export function buildFullCsv(results: CheckResult[]): string {
  return toCsv(FULL_CSV_COLUMNS, results.map(rowOf));
}

// ---------------------------------------------------------------------------
// Issues only
// ---------------------------------------------------------------------------

/** Maps that did not load (the "Issues" card). Same columns as the full export. */
export function buildIssuesCsv(results: CheckResult[]): string {
  return toCsv(FULL_CSV_COLUMNS, results.filter((r) => isFailure(r.status)).map(rowOf));
}

// ---------------------------------------------------------------------------
// Live sheet write-back / sheet-ready export
// ---------------------------------------------------------------------------

export type DateFormat = 'iso' | 'dmy';

/** YYYY-MM-DD -> DD-MM-YYYY when asked; anything else (None, text) passes through. */
export function formatDate(d: string, fmt: DateFormat): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return fmt === 'dmy' && m ? `${m[3]}-${m[2]}-${m[1]}` : d;
}

const joinUniq = (vals: string[]) => [...new Set(vals.filter(Boolean))].join('; ');

const normHeader = (h: string | undefined) => (h ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** The index of the first column whose header matches one of `aliases`, or -1. */
function findColumn(headerRow: string[], aliases: string[]): number {
  const normalized = headerRow.map(normHeader);
  for (const alias of aliases) { const i = normalized.indexOf(alias); if (i >= 0) return i; }
  return -1;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Read a sheet date cell to YYYY-MM-DD for comparison. Accepts ISO or the sheet's DD-MM-YYYY (day first); else null. */
export function parseSheetDate(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const ok = (y: number, mo: number, d: number) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad2(mo)}-${pad2(d)}` : null);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s); // sheet convention: day-month-year
  if (m) return ok(+m[3], +m[2], +m[1]);
  return null;
}

/**
 * Updation Status, comparing the real Primary Date found (ISO) against the sheet's recorded New date.
 * One day matters: newer -> "Updation", same -> "No Updation", older -> "Date issue". No real date, or no
 * comparable New date, leaves it blank (nothing to compare; a missing date is never an issue).
 */
export function updationStatus(realPrimaryIso: string | null, newDateCell: string): string {
  if (!realPrimaryIso) return '';
  const base = parseSheetDate(newDateCell);
  if (!base) return 'Updation'; // a date was found where the sheet had none (or an unreadable one) to compare
  if (realPrimaryIso > base) return 'Updation';
  if (realPrimaryIso === base) return 'No Updation';
  return 'Date issue'; // the found date is older than the recorded New date — a wrong/stale date
}

/**
 * A map that loaded but carries no date anywhere (OK_NO_DATE) is compared by its Review Date, so its Updation Status
 * is not left blank. A map that failed to load still has nothing to compare and stays blank.
 */
function reviewDateOfNoDateMaps(results: CheckResult[]): string | null {
  const dates = results.filter((r) => r.status === 'OK_NO_DATE' && /^\d{4}-\d{2}-\d{2}$/.test(r.reviewDate)).map((r) => r.reviewDate);
  return dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
}

/** The newest real (endpoint/attribute) Primary Date across a row's checks, ISO, or null when none was found. */
function latestRealPrimary(results: CheckResult[]): string | null {
  const reals = results.filter(hasRealDate).map((r) => r.primaryDate);
  return reals.length ? reals.reduce((a, b) => (b > a ? b : a)) : null;
}

/**
 * The columns written to the live sheet (and the sheet-ready download). Each reuses one of the sheet's own
 * columns when a header matches an alias (so the recent/checked date fills the existing Last_Reviewed column),
 * otherwise it is appended. `rename` overwrites a reused header with the canonical name. The sheet's own
 * New date column is never written — it stays as the baseline the Updation Status compares against.
 */
interface WriteBackSpec {
  name: string;
  aliases: string[];
  rename: boolean;
  value: (results: CheckResult[], fmt: DateFormat, newDateCell: string) => string;
}

const WRITEBACK_SPEC: WriteBackSpec[] = [
  { name: 'Primary Date', aliases: ['primarydate'], rename: true,
    value: (rs, fmt) => joinUniq(rs.map((r) => formatDate(effectivePrimaryDate(r), fmt))) },
  { name: 'Updation Status', aliases: ['updationstatus', 'updation'], rename: true,
    value: (rs, _fmt, nd) => updationStatus(latestRealPrimary(rs) ?? reviewDateOfNoDateMaps(rs), nd) },
  { name: 'Last Reviewed', aliases: ['lastreviewed', 'lastreview', 'recentdate', 'recent', 'datereviewed'], rename: false,
    value: (rs, fmt) => joinUniq(rs.map((r) => formatDate(r.reviewDate, fmt))) },
  { name: 'Map Issues', aliases: ['mapissues', 'mapissue', 'issues', 'issue'], rename: true,
    value: (rs) => joinUniq(rs.map(oneIssueText)) },
];

/** The canonical names of the write-back columns, in order. */
export const WRITEBACK_COLUMNS = WRITEBACK_SPEC.map((s) => s.name);

/** Where each write-back column lands: reuse a matching existing column (by alias) or append after the used columns. */
function planWriteBack(headerRow: string[]): { name: string; index: number; value: WriteBackSpec['value'] }[] {
  const normalized = headerRow.map(normHeader);
  let next = headerRow.length;
  while (next > 0 && normalized[next - 1] === '') next--;
  const used = new Set<number>();
  return WRITEBACK_SPEC.map((spec) => {
    let at = -1;
    for (const alias of spec.aliases) {
      const i = normalized.indexOf(alias);
      if (i >= 0 && !used.has(i)) { at = i; break; }
    }
    if (at >= 0) {
      used.add(at);
      return { name: spec.rename ? spec.name : (headerRow[at]?.trim() || spec.name), index: at, value: spec.value };
    }
    const col = next++;
    used.add(col);
    return { name: spec.name, index: col, value: spec.value };
  });
}

export interface SheetMatrix {
  columns: { name: string; index: number }[];
  /** Full table with the extra columns filled in; row 0 is the header row. Blank source rows stay blank. */
  table: string[][];
  /** Just the added cells per table row (row 0 = headers), for writing back. */
  audit: string[][];
}

/**
 * Lay the source sheet out unchanged, then fill the given columns from each row's result(s). Rows dropped
 * as blank are kept (empty added cells) so a paste or a write-back cannot shift anything.
 */
function assembleMatrix(
  table: string[][],
  rows: CheckRow[],
  results: Record<string, CheckResult>,
  columns: { name: string; index: number }[],
  cellsFor: (results: CheckResult[], src: string[]) => string[],
): SheetMatrix {
  const width = Math.max(...table.map((r) => r.length), ...columns.map((c) => c.index + 1));
  const bySheetRow = new Map<number, CheckResult[]>();
  for (const row of rows) {
    const r = results[row.id];
    if (!r) continue;
    const list = bySheetRow.get(row.sheetRow) ?? [];
    list.push(r);
    bySheetRow.set(row.sheetRow, list);
  }
  const out: string[][] = [];
  const audit: string[][] = [];
  table.forEach((src, i) => {
    const line = Array.from({ length: width }, (_, c) => src[c] ?? '');
    const cells = i === 0 ? columns.map((c) => c.name) : cellsFor(bySheetRow.get(i + 1) ?? [], src);
    columns.forEach((c, k) => (line[c.index] = cells[k]));
    out.push(line);
    audit.push(cells);
  });
  return { columns, table: out, audit };
}

/**
 * The sheet plus the four result columns — Primary Date (the found endpoint/attribute date, or the review
 * date when none), Updation Status (Primary Date vs the sheet's New date), the recent/checked date (filling
 * the sheet's Last_Reviewed column), and Map Issues. The sheet's own columns, New date included, are left
 * exactly as they are so the comparison keeps a stable baseline.
 */
export function buildWriteBackMatrix(table: string[][], rows: CheckRow[], results: Record<string, CheckResult>, fmt: DateFormat = 'iso'): SheetMatrix {
  const header = table[0] ?? [];
  const newDateIdx = findColumn(header, ['newdate']);
  const oldDateIdx = findColumn(header, ['olddate']);
  const cols = planWriteBack(header);
  // Updation Status compares against the sheet's New date; when that cell has no usable date, it falls back
  // to the Old date so a row that only has an old date is still compared instead of always counted new.
  const baselineOf = (src: string[]): string => {
    const nd = newDateIdx >= 0 ? src[newDateIdx] ?? '' : '';
    if (parseSheetDate(nd)) return nd;
    return oldDateIdx >= 0 ? src[oldDateIdx] ?? '' : '';
  };
  return assembleMatrix(table, rows, results, cols, (rs, src) => (rs.length === 0 ? cols.map(() => '') : cols.map((c) => c.value(rs, fmt, baselineOf(src)))));
}

/** The sheet-ready CSV download: identical columns to the live write-back, one line per source line. */
export function buildSheetReadyCsv(table: string[][], rows: CheckRow[], results: Record<string, CheckResult>, fmt: DateFormat = 'iso'): string {
  const m = buildWriteBackMatrix(table, rows, results, fmt);
  return toCsv(m.table[0], m.table.slice(1));
}

export const COPY_COLUMNS = ['ID', 'City', 'County', 'State', 'Old date', 'New date', 'Primary Date', 'Review Date', 'Updation Status', 'Map Issues'] as const;

/**
 * The compact table behind "Review & copy": only ID, City, County, State, Old date, New date (all read from the
 * sheet as written) plus the audit's Primary Date, Review Date, Updation Status and Map Issues. One line per
 * source line, blank lines kept, so pasting it next to the sheet cannot shift a row. The ID is always the sheet's
 * own ID cell (never generated); with no ID column found, the cell stays empty.
 */
export function buildCopyTable(
  table: string[][],
  rows: CheckRow[],
  results: Record<string, CheckResult>,
  mapping: { city: number | null; state: number | null; county: number | null },
  fmt: DateFormat = 'iso',
): string[][] {
  const header = table[0] ?? [];
  const mapped = new Set([mapping.city, mapping.state, mapping.county]);
  // The sheet's own ID column: the "City ID" header first, then an exact "id" header, else any header that starts or ends with "id" (City ID, ID_No),
  // else the column just left of the City column when nothing else claims it (IDs normally lead the sheet).
  let idIdx = findColumn(header, ['cityid', 'id', 'mapid', 'recordid']);
  if (idIdx < 0) idIdx = header.findIndex((h, i) => !mapped.has(i) && /^id|id$/.test(normHeader(h)) && normHeader(h) !== 'valid');
  if (idIdx < 0 && mapping.city !== null && mapping.city > 0 && !mapped.has(mapping.city - 1)) idIdx = mapping.city - 1;
  const oldIdx = findColumn(header, ['olddate']);
  const newIdx = findColumn(header, ['newdate']);
  const matrix = buildWriteBackMatrix(table, rows, results, fmt);
  const get = (src: string[], i: number | null) => (i !== null && i >= 0 ? (src[i] ?? '').trim() : '');
  const out: string[][] = [[...COPY_COLUMNS]];
  for (let i = 1; i < table.length; i++) {
    const src = table[i];
    const a = matrix.audit[i];
    out.push([
      get(src, idIdx),
      get(src, mapping.city), get(src, mapping.county), get(src, mapping.state),
      get(src, oldIdx), get(src, newIdx),
      // audit cells follow WRITEBACK_SPEC order: Primary Date, Updation Status, Last Reviewed, Map Issues
      a[0] ?? '', a[2] ?? '', a[1] ?? '', a[3] ?? '',
    ]);
  }
  return out;
}
