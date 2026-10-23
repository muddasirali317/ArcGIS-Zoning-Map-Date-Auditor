/**
 * Date handling (PRD 5.3 / 5.4). Everything is UTC; nothing is converted to local time.
 */

export interface DateValue {
  /** YYYY-MM-DD (UTC) */
  date: string;
  /** Full ISO timestamp (UTC) */
  iso: string;
}

export type EpochResult = ({ kind: 'valid' } & DateValue) | { kind: 'sentinel'; reason: string };

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Esri dates are epoch milliseconds in UTC. Zero, negative values and the configured
 * default dates (1899-12-30, 1900-01-01, 1970-01-01) are treated as missing.
 */
export function fromEpochMs(ms: number, sentinels: Set<string>): EpochResult {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return { kind: 'sentinel', reason: 'not a number' };
  if (ms === 0) return { kind: 'sentinel', reason: 'epoch zero (1970-01-01)' };
  // Esri's own date fields are epoch milliseconds, but some services store epoch seconds. A positive
  // value that is only plausible as seconds for a modern date (≈2001–2103) and would otherwise land in
  // January 1970 is rescued by scaling to milliseconds. The window is deliberately narrow so genuine
  // millisecond timestamps are never rescaled.
  if (ms >= 1e9 && ms <= 4.2e9) ms = ms * 1000;
  if (ms < 0) {
    const d = new Date(ms);
    const label = Number.isNaN(d.getTime()) ? 'negative value' : `negative value (${d.toISOString().slice(0, 10)})`;
    return { kind: 'sentinel', reason: label };
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return { kind: 'sentinel', reason: 'out of range' };
  // Years outside 0001–9999 (JavaScript writes them as +033658-… expanded form) are a units mistake,
  // not a real edit date; rejecting them keeps a mangled "+03365" string out of the results.
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return { kind: 'sentinel', reason: 'year out of range' };
  const iso = d.toISOString();
  const date = iso.slice(0, 10);
  if (sentinels.has(date)) return { kind: 'sentinel', reason: `default date ${date}` };
  return { kind: 'valid', date, iso };
}

export function isFuture(date: string, now: Date): boolean {
  return date > now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Text dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const toValue = (y: number, m: number, d: number): DateValue => {
  const date = `${y}-${pad(m)}-${pad(d)}`;
  return { date, iso: `${date}T00:00:00.000Z` };
};

/** Two-digit year -> four digits. 00–69 are read as 2000–2069, 70–99 as 1970–1999. Four-digit years pass through. */
function expandYear(y: number): number {
  if (y >= 100) return y;
  return y <= 69 ? 2000 + y : 1900 + y;
}

/** Strip wrapping quotes/brackets, non-breaking and zero-width spaces, so a stray wrapper never hides a real date. */
function cleanRaw(raw: string): string {
  return raw
    .replace(/[​-‍﻿]/g, '')
    .replace(/ /g, ' ')
    .trim()
    .replace(/^[["'(\s]+/, '')
    .replace(/[\]"')\s]+$/, '')
    .trim();
}

type Token =
  | { kind: 'ymd'; y: number; m: number; d: number }
  | { kind: 'pair'; a: number; b: number; y: number }
  | { kind: 'none' };

// Optional trailing time, which is ignored: a text date is taken literally, never shifted by a time zone.
const TIME_TAIL = String.raw`(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s?(?:Z|[+-]\d{2}:?\d{2}|[AaPp][Mm])?)?`;
// Separators accepted between the day, month name and year of a written date (space, comma, . / -).
const MSEP = String.raw`[\s,./-]+`;
const RE_YMD = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME_TAIL}$`);
const RE_COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
// Day/month pair with a 2- or 4-digit trailing year, e.g. 14-05-2023, 5/14/23.
const RE_PAIR = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})${TIME_TAIL}$`);
// Month-name forms, with any of the separators above and a 2- or 4-digit year: May 14, 2023; 14-MAY-23.
const RE_MON_FIRST = new RegExp(String.raw`^([A-Za-z]{3,9})\.?${MSEP}(\d{1,2})(?:st|nd|rd|th)?${MSEP}(\d{2}|\d{4})$`);
const RE_DAY_FIRST = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?${MSEP}([A-Za-z]{3,9})\.?${MSEP}(\d{2}|\d{4})$`);

function tokenize(raw: string): Token {
  const s = cleanRaw(raw);
  let m = RE_YMD.exec(s);
  if (m) return { kind: 'ymd', y: +m[1], m: +m[2], d: +m[3] };
  m = RE_COMPACT.exec(s);
  if (m) return { kind: 'ymd', y: +m[1], m: +m[2], d: +m[3] };
  m = RE_PAIR.exec(s);
  if (m) return { kind: 'pair', a: +m[1], b: +m[2], y: expandYear(+m[3]) };
  m = RE_MON_FIRST.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return { kind: 'ymd', y: expandYear(+m[3]), m: MONTHS[m[1].toLowerCase()], d: +m[2] };
  m = RE_DAY_FIRST.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return { kind: 'ymd', y: expandYear(+m[3]), m: MONTHS[m[2].toLowerCase()], d: +m[1] };
  return { kind: 'none' };
}

export interface StringDateParse {
  valid: (DateValue & { raw: string })[];
  /** Raw values that parsed to a configured default date. */
  sentinels: string[];
  /** Raw values like 03/04/2023 where day and month cannot be told apart. */
  ambiguous: string[];
  /** Raw values that matched no known format. */
  unparsed: string[];
}

/**
 * Parse the text values of one field. Day/month order for `a/b/yyyy` values is inferred
 * from the whole set: any value with a first part > 12 proves D/M/Y, any with a second
 * part > 12 proves M/D/Y. If the set never settles it, ambiguous values are reported
 * (never guessed).
 */
export function parseDateStrings(values: string[], sentinels: Set<string>): StringDateParse {
  const tokens = values.map((raw) => ({ raw, tok: tokenize(raw) }));
  const pairs = tokens.flatMap((t) => (t.tok.kind === 'pair' ? [t.tok] : []));
  const provesDmy = pairs.some((p) => p.a > 12);
  const provesMdy = pairs.some((p) => p.b > 12);
  const setOrder: 'dmy' | 'mdy' | null = provesDmy && !provesMdy ? 'dmy' : provesMdy && !provesDmy ? 'mdy' : null;

  const out: StringDateParse = { valid: [], sentinels: [], ambiguous: [], unparsed: [] };
  for (const { raw, tok } of tokens) {
    let ymd: [number, number, number] | null = null;
    if (tok.kind === 'none') {
      out.unparsed.push(raw);
      continue;
    }
    if (tok.kind === 'ymd') {
      ymd = [tok.y, tok.m, tok.d];
    } else {
      const { a, b, y } = tok;
      if (a > 12 && b <= 12) ymd = [y, b, a];
      else if (b > 12 && a <= 12) ymd = [y, a, b];
      else if (a === b) ymd = [y, a, b];
      else if (a <= 12 && b <= 12 && setOrder === 'mdy') ymd = [y, a, b];
      else if (a <= 12 && b <= 12 && setOrder === 'dmy') ymd = [y, b, a];
      else {
        out.ambiguous.push(raw);
        continue;
      }
    }
    if (!validYmd(ymd[0], ymd[1], ymd[2])) {
      out.unparsed.push(raw);
      continue;
    }
    const v = toValue(ymd[0], ymd[1], ymd[2]);
    if (sentinels.has(v.date)) out.sentinels.push(raw);
    else out.valid.push({ ...v, raw });
  }
  return out;
}

/** Latest valid date in a parse result, or null. */
export function latest(parse: StringDateParse): (DateValue & { raw: string }) | null {
  let best: (DateValue & { raw: string }) | null = null;
  for (const v of parse.valid) if (!best || v.date > best.date) best = v;
  return best;
}

export function earliest(parse: StringDateParse): (DateValue & { raw: string }) | null {
  let best: (DateValue & { raw: string }) | null = null;
  for (const v of parse.valid) if (!best || v.date < best.date) best = v;
  return best;
}

/** Local calendar date, YYYY-MM-DD (used for the Review Date, which is the analyst's "today"). */
export function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
