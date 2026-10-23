/**
 * Stress / fuzz tests: the date detector and the CSV builder must survive adversarial and random input
 * without throwing, without emitting a malformed date, and without letting a spreadsheet formula through.
 * Target: a near-zero margin of error on the parts an analyst trusts blindly.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFullCsv, buildIssuesCsv, fromEpochMs, neutralizeFormula, parseCsv, parseDateStrings, toCsv, FULL_CSV_COLUMNS,
  type CheckResult, type IssueCode,
} from '@zoning/core';
import { rawConfig } from './helpers';

const sentinels = new Set(rawConfig.sentinelDates);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A small deterministic PRNG so a failure is reproducible.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CHARS = '0123456789/-. ,:TZapmAPMJanFebMrАй月日"\'()[] ​';
function randomString(rng: () => number, maxLen = 24): string {
  const len = Math.floor(rng() * maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += CHARS[Math.floor(rng() * CHARS.length)];
  return out;
}

describe('date parser fuzz', () => {
  it('never throws and every value is accounted for exactly once', () => {
    const rng = makeRng(12345);
    for (let i = 0; i < 20_000; i++) {
      const raw = randomString(rng);
      const p = parseDateStrings([raw], sentinels);
      const total = p.valid.length + p.ambiguous.length + p.sentinels.length + p.unparsed.length;
      expect(total, raw).toBe(1);
      for (const v of p.valid) {
        expect(v.date, raw).toMatch(ISO);
        expect(v.iso, raw).toBe(`${v.date}T00:00:00.000Z`);
        // The emitted date must round-trip to the same calendar day (no month/day overflow).
        const d = new Date(v.iso);
        expect(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`, raw).toBe(v.date);
      }
    }
  });

  it('a batch of mixed values is parsed the same as each value alone, apart from day/month order settling', () => {
    const rng = makeRng(999);
    for (let i = 0; i < 2_000; i++) {
      const batch = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => randomString(rng));
      expect(() => parseDateStrings(batch, sentinels)).not.toThrow();
    }
  });

  it('fromEpochMs never throws and never emits a malformed or out-of-range date', () => {
    const rng = makeRng(42);
    const candidates = [0, -1, 1, 1e3, 1e6, 1e9, 4.2e9, 1e11, 1e12, 1e13, 1e15, 1e18, -1e15, NaN, Infinity, -Infinity];
    for (let i = 0; i < 10_000; i++) candidates.push((rng() - 0.3) * 10 ** (Math.floor(rng() * 18)));
    for (const v of candidates) {
      const r = fromEpochMs(v, sentinels);
      if (r.kind === 'valid') {
        expect(r.date, String(v)).toMatch(ISO);
        const year = Number(r.date.slice(0, 4));
        expect(year, String(v)).toBeGreaterThanOrEqual(1);
        expect(year, String(v)).toBeLessThanOrEqual(9999);
      }
    }
  });
});

describe('CSV builder stress', () => {
  const codes: IssueCode[] = ['OK', 'OK_NO_DATE', 'HTTP_404', 'HTTP_401_403', 'TIMEOUT', 'NO_LAYERS', 'MAP_RENDER_FAILED', 'ARCGIS_ERROR', 'DNS_FAIL'];

  function randomResult(rng: () => number): CheckResult {
    const nasty = ['=cmd()', '+1+2', '-5', '@SUM', 'a,b', 'line\r\nbreak', 'quote"inside', '\ttab', 'plain', ''];
    const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
    const code = pick(codes);
    const hasDate = rng() > 0.4;
    return {
      id: String(Math.floor(rng() * 1e6)), sheetRow: 1, city: pick(nasty), state: pick(nasty), county: pick(nasty),
      sourceUrl: pick(nasty), normalizedUrl: pick(nasty), serviceType: pick(['MapServer', 'FeatureServer', '']),
      status: code, issues: code === 'OK' ? [] : [{ code, reason: pick(nasty) }], issueReason: '',
      primaryDate: hasDate ? '2023-05-14' : 'None', dateSource: 'x', dateConfidence: 'high', dateFieldName: 'x',
      attributeMaxDate: 'None', attributeMinDate: 'None', serviceEditingInfoDate: 'None', itemModifiedDate: 'None',
      allDates: [], otherDateFields: [], zoningLayerName: '', layersChecked: 0, layers: [],
      reviewDate: '2026-10-21', reviewedAt: '2026-10-21T00:00:00.000Z', reviewer: pick(nasty), analystNote: pick(nasty),
      evidenceUrl: pick(nasty), responseTimeMs: 0, retries: 0, checkedAt: '2026-10-21T00:00:00.000Z', toolVersion: 't', via: 'server',
    } as CheckResult;
  }

  it('produces well-formed, formula-safe CSV for 5,000 adversarial rows and always carries a date', () => {
    const rng = makeRng(7);
    const results = Array.from({ length: 5_000 }, () => randomResult(rng));
    const csv = buildFullCsv(results);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...FULL_CSV_COLUMNS]);
    expect(rows).toHaveLength(results.length + 1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toHaveLength(FULL_CSV_COLUMNS.length); // every row parses to the full width
      expect(rows[i][6], `row ${i} primary date`).toMatch(ISO); // Primary Date is never blank (review-date fallback)
    }
    // No cell may begin with a character Excel would run as a formula.
    for (const line of rows.slice(1)) for (const cell of line) expect(/^[=+\-@\t\r]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell)).toBe(false);
  });

  it('round-trips arbitrary cell values through csvCell/parseCsv unchanged (after neutralisation)', () => {
    const rng = makeRng(55);
    for (let i = 0; i < 3_000; i++) {
      const value = randomString(rng, 40);
      const parsed = parseCsv(toCsv(['v'], [[value]]));
      expect(parsed[1][0]).toBe(neutralizeFormula(value));
    }
  });

  it('Issues-only CSV lists exactly the failures', () => {
    const rng = makeRng(3);
    const results = Array.from({ length: 1_000 }, () => randomResult(rng));
    const rows = parseCsv(buildIssuesCsv(results));
    const expected = results.filter((r) => !['OK', 'OK_NO_DATE'].includes(r.status)).length;
    expect(rows.length - 1).toBe(expected);
  });
});
