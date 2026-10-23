/** Phase 3: Sheet-ready CSV, Issues-only CSV, fallback link column, date-field suggestions, no-date re-check. */
import { describe, expect, it } from 'vitest';
import {
  buildFullCsv, buildIssuesCsv, buildRows, buildSheetReadyCsv, buildWriteBackMatrix, classifyFieldName, fieldOf, normalizeName, parseCsv,
  parseSheetDate, planSync, suggestDateFields, suggestMapping, updationStatus, WRITEBACK_COLUMNS, type CheckResult, type CheckRow,
} from '@zoning/core';

const mkResult = (row: CheckRow, over: Partial<CheckResult> = {}): CheckResult =>
  ({
    id: row.id, sheetRow: row.sheetRow, city: row.city, state: row.state, county: row.county, sourceUrl: row.url,
    normalizedUrl: 'https://a.gov/arcgis/rest/services/Z/MapServer', serviceType: 'MapServer',
    status: 'OK', issues: [], issueReason: '', primaryDate: '2026-05-14', dateSource: 'Attribute:EditDate', dateConfidence: 'high',
    reviewDate: '2026-10-21', reviewer: '', analystNote: '', evidenceUrl: 'https://x.gov/e?f=json', checkedAt: '2026-10-21T10:00:00.000Z',
    otherDateFields: [], allDates: [], layers: [], layersChecked: 1, ...over,
  }) as CheckResult;

const TABLE = parseCsv(
  [
    'ID,City,State,Endpoint,Old_Date,',
    '1,Austin,TX,https://a.gov/arcgis/rest/services/Z/MapServer,01-02-2025,',
    ',,,,,', // blank row: dropped from the checks, must still occupy its line
    '3,Dallas,TX,"https://b.gov/arcgis/rest/services/Z/MapServer https://b.gov/arcgis/rest/services/Y/MapServer",05-06-2024,',
    '4,Tulsa,OK,https://c.gov/arcgis/rest/services/Z/MapServer,,',
    '5,Reno,NV,,,',
  ].join('\n'),
);
const mapping = { city: 1, state: 2, county: null, url: 3 };

function setup() {
  const built = buildRows(TABLE, mapping);
  const results: Record<string, CheckResult> = {};
  for (const r of built.rows) results[r.id] = mkResult(r);
  results['4.2'] = mkResult(built.rows.find((r) => r.id === '4.2')!, { status: 'HTTP_404', primaryDate: 'None', dateSource: 'None', issues: [{ code: 'HTTP_404', reason: 'Not found' }], issueReason: 'Not found' });
  delete results['6']; // Reno (sheet line 6) not checked yet
  return { built, results };
}

describe('Sheet-ready CSV (PRD 11)', () => {
  it('appends exactly the write-back columns — no audit columns, no duplicate New date — one line per source line', () => {
    const { built, results } = setup();
    const csv = buildSheetReadyCsv(TABLE, built.rows, results);
    const lines = parseCsv(csv);
    expect(lines).toHaveLength(TABLE.length); // one line per source line, blank rows kept
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(lines[0].slice(0, 5)).toEqual(['ID', 'City', 'State', 'Endpoint', 'Old_Date']); // the sheet's own columns, untouched
    expect(lines[0].slice(5)).toEqual([...WRITEBACK_COLUMNS]); // then Primary Date, Updation Status, Last Reviewed, Map Issues
    expect(lines[0].filter((h) => /audit/i.test(h) || h === 'New date')).toEqual([]); // none of the old audit / duplicate-date garbage
  });

  it('neutralises spreadsheet formulas in the written cells', () => {
    const { built, results } = setup();
    results['2'] = mkResult(built.rows[0], { status: 'ARCGIS_ERROR', issues: [{ code: 'ARCGIS_ERROR', reason: '=cmd() bad' }] });
    const csv = buildSheetReadyCsv(TABLE, built.rows, results);
    expect(csv).not.toMatch(/(^|,)=cmd/m);
    expect(csv).toContain("'=cmd");
  });

  it('exports the focused columns and the exact on-screen messages, split into map (Issue) and link (Issue 2)', () => {
    const { built, results } = setup();
    results['2'] = mkResult(built.rows[0], {
      primaryDate: '2026-05-14',
      status: 'HTTP_401_403',
      // a map-side problem (secured / administrative approval) and a link-side problem (dead endpoint)
      issues: [
        { code: 'HTTP_401_403', reason: 'Administrative approval required to view this layer.' },
        { code: 'HTTP_404', reason: 'The endpoint returned 404; the service was moved.' },
      ],
    });
    const lines = parseCsv(buildFullCsv(Object.values(results)));
    expect(lines[0]).toEqual([
      'City', 'County', 'State', 'Source Link', 'Endpoint', 'Feature Type', 'Primary Date', 'Review Date', 'Evidence URL', 'Issue', 'Issue 2',
    ]);
    expect(lines[1]).toEqual([
      'Austin', '', 'TX', 'https://a.gov/arcgis/rest/services/Z/MapServer', 'https://a.gov/arcgis/rest/services/Z/MapServer', 'MapServer', '2026-05-14', '2026-10-21',
      'https://x.gov/e?f=json',
      'Administrative approval required to view this layer.',
      'The endpoint returned 404; the service was moved.',
    ]);
  });

  it('a no-date map gets the review date as Primary Date and is NOT reported as an issue', () => {
    const { built, results } = setup();
    results['2'] = mkResult(built.rows[0], {
      status: 'OK_NO_DATE', primaryDate: 'None', dateSource: 'None',
      issues: [{ code: 'OK_NO_DATE', reason: 'The map loaded, but no date was found.' }],
    });
    const lines = parseCsv(buildFullCsv(Object.values(results)));
    expect(lines[1][6]).toBe('2026-10-21'); // Primary Date falls back to the Review Date
    expect(lines[1][7]).toBe('2026-10-21'); // Review Date
    expect(lines[1][9]).toBe(''); // Issue (map side) — "no date" is not an issue
    expect(lines[1][10]).toBe(''); // Issue 2 (link side) empty
  });

  it('keeps the same focused columns and puts a link failure in Issue 2 in the Issues-only CSV', () => {
    const { built, results } = setup();
    results['4.2'] = mkResult(built.rows.find((r) => r.id === '4.2')!, {
      status: 'HTTP_404', primaryDate: 'None',
      issues: [{ code: 'HTTP_404', reason: 'Not found: layer 7.' }],
    });
    const csv = buildIssuesCsv(Object.values(results));
    const lines = parseCsv(csv);
    expect(lines).toHaveLength(2);
    expect(lines[0][0]).toBe('﻿City'.slice(1));
    expect(lines[1][9]).toBe(''); // Issue (map side) empty
    expect(lines[1][10]).toBe('Not found: layer 7.'); // Issue 2 (link side)
  });

});

describe('Live write-back (Primary Date, Updation Status, Map Issues)', () => {
  // A sheet with a New_Date baseline column, one row per comparison case.
  const UT = parseCsv([
    'City,Endpoint,New_Date',
    'Newer,https://a.gov/arcgis/rest/services/Z/MapServer,01-01-2020',  // found 2026-05-14 is newer
    'Same,https://b.gov/arcgis/rest/services/Z/MapServer,14-05-2026',   // found date equals the New date
    'Older,https://c.gov/arcgis/rest/services/Z/MapServer,01-01-2030',  // found date is older than the New date
    'OneDayBack,https://d.gov/arcgis/rest/services/Z/MapServer,15-05-2026', // New date one day ahead of the found date
    'NoDate,https://e.gov/arcgis/rest/services/Z/MapServer,10-10-2024', // map loaded with no date
    'NoBaseline,https://f.gov/arcgis/rest/services/Z/MapServer,',       // a date found but the sheet has none recorded
  ].join('\n'));
  const utMapping = { city: 0, state: null, county: null, url: 1 };
  function utSetup() {
    const b = buildRows(UT, utMapping);
    const r: Record<string, CheckResult> = {};
    for (const row of b.rows) r[row.id] = mkResult(row, { primaryDate: '2026-05-14', reviewDate: '2026-10-21' });
    r['6'] = mkResult(b.rows.find((x) => x.id === '6')!, { status: 'OK_NO_DATE', primaryDate: 'None', issues: [{ code: 'OK_NO_DATE', reason: 'no date' }] }); // NoDate row
    return { b, r };
  }

  it('adds exactly Primary Date, Updation Status and Map Issues, and leaves the sheet (New_Date included) untouched', () => {
    const { b, r } = utSetup();
    const m = buildWriteBackMatrix(UT, b.rows, r);
    expect(m.table[0].slice(3)).toEqual([...WRITEBACK_COLUMNS]); // appended after City,Endpoint,New_Date
    for (let i = 0; i < UT.length; i++) for (let c = 0; c < 3; c++) expect(m.table[i][c], `r${i}c${c}`).toBe(UT[i][c] ?? '');
  });

  it('marks Updation Status by comparing the found Primary Date with the sheet New date — one day matters', () => {
    const { b, r } = utSetup();
    const m = buildWriteBackMatrix(UT, b.rows, r);
    const S = m.columns.find((c) => c.name === 'Updation Status')!.index;
    expect(m.table[1][S]).toBe('Updation');     // 2026-05-14 > 2020-01-01
    expect(m.table[2][S]).toBe('No Updation');   // 2026-05-14 == 2026-05-14
    expect(m.table[3][S]).toBe('Date issue');    // 2026-05-14 < 2030-01-01
    expect(m.table[4][S]).toBe('Date issue');    // 2026-05-14 is one day behind 2026-05-15
    expect(m.table[5][S]).toBe('Updation');      // loaded with no date (OK_NO_DATE): its review date (2026) is compared with 2024
    expect(m.table[6][S]).toBe('Updation');      // a date found where the sheet recorded none
  });

  it('falls back to Old_Date for Updation Status when New_Date is empty', () => {
    const t = parseCsv([
      'City,Endpoint,Old_Date,New_Date',
      'OldNewer,https://a.gov/arcgis/rest/services/Z/MapServer,01-01-2020,',       // New empty -> vs Old 2020 -> found newer
      'OldSame,https://b.gov/arcgis/rest/services/Z/MapServer,14-05-2026,',        // New empty -> vs Old equal
      'OldAhead,https://c.gov/arcgis/rest/services/Z/MapServer,01-01-2030,',       // New empty -> vs Old newer -> stale
      'HasNew,https://d.gov/arcgis/rest/services/Z/MapServer,05-05-2020,10-10-2026', // New present -> compared vs New, not Old
    ].join('\n'));
    const b = buildRows(t, { city: 0, state: null, county: null, url: 1 });
    const r: Record<string, CheckResult> = {};
    for (const row of b.rows) r[row.id] = mkResult(row, { primaryDate: '2026-05-14', reviewDate: '2026-10-21' });
    const m = buildWriteBackMatrix(t, b.rows, r);
    const S = m.columns.find((c) => c.name === 'Updation Status')!.index;
    expect(m.table[1][S]).toBe('Updation');    // vs Old 2020-01-01
    expect(m.table[2][S]).toBe('No Updation');  // vs Old 2026-05-14
    expect(m.table[3][S]).toBe('Date issue');   // vs Old 2030-01-01
    expect(m.table[4][S]).toBe('Date issue');   // vs New 2026-10-10 (New present wins over Old)
  });

  it('Primary Date holds the found date (review date when none), and Map Issues never shows "no date"', () => {
    const { b, r } = utSetup();
    const m = buildWriteBackMatrix(UT, b.rows, r);
    const P = m.columns.find((c) => c.name === 'Primary Date')!.index;
    const I = m.columns.find((c) => c.name === 'Map Issues')!.index;
    expect(m.table[1][P]).toBe('2026-05-14');   // a real found date
    expect(m.table[5][P]).toBe('2026-10-21');   // NoDate row falls back to the review date
    expect(m.table[5][I]).toBe('');             // "no date" is not a map issue
  });

  it('a link that failed reports its message in Map Issues', () => {
    const { built, results } = setup();
    const m = buildWriteBackMatrix(TABLE, built.rows, results); // Dallas row: one OK link, one 404
    const I = m.columns.find((c) => c.name === 'Map Issues')!.index;
    expect(m.table[3][I]).toBe('Not found');
  });

  it('writes dates DD-MM-YYYY when asked, to match the sheet', () => {
    const { b, r } = utSetup();
    const m = buildWriteBackMatrix(UT, b.rows, r, 'dmy');
    const P = m.columns.find((c) => c.name === 'Primary Date')!.index;
    expect(m.table[1][P]).toBe('14-05-2026');
  });

  it('updationStatus / parseSheetDate read ISO and DD-MM-YYYY and treat one day as significant', () => {
    expect(parseSheetDate('11-08-2026')).toBe('2026-08-11'); // DD-MM-YYYY (day first)
    expect(parseSheetDate('2026-08-11')).toBe('2026-08-11'); // ISO
    expect(parseSheetDate('not a date')).toBeNull();
    expect(updationStatus('2026-05-15', '14-05-2026')).toBe('Updation');    // one day newer
    expect(updationStatus('2026-05-14', '14-05-2026')).toBe('No Updation');
    expect(updationStatus('2026-05-13', '14-05-2026')).toBe('Date issue');  // one day older
    expect(updationStatus(null, '14-05-2026')).toBe('');                    // no found date
  });
});

describe('Issues-only CSV', () => {
  it('lists only the maps that did not load', () => {
    const { built, results } = setup();
    const csv = buildIssuesCsv(Object.values(results).filter(Boolean));
    const lines = parseCsv(csv);
    expect(lines).toHaveLength(2); // header + the one 404
    expect(lines[1][10]).toContain('Not found'); // the 404 reason lands in Issue 2 (link side)
    expect(lines[0][0]).toBe('﻿City'.slice(1));
    void built;
  });
});

describe('fallback link column', () => {
  const t = parseCsv('City,State,REST,Viewer\nA,TX,,https://city.maps.arcgis.com/apps/instant/index.html?appid=0123456789abcdef0123456789abcdef\nB,TX,https://b.gov/x/MapServer,https://v.arcgis.com/apps/x?id=0123456789abcdef0123456789abcdef\nC,TX,,\nD,TX,coming soon,https://d.maps.arcgis.com/home/item.html?id=0123456789abcdef0123456789abcdef');

  it('is off unless chosen', () => {
    const r = buildRows(t, { city: 0, state: 1, county: null, url: 2 });
    expect(r.rows.map((x) => x.url)).toEqual(['', 'https://b.gov/x/MapServer', '', 'coming soon']);
    expect(r.rows.some((x) => x.fallback)).toBe(false);
  });

  it('fills only rows whose Map URL has no link, and marks them', () => {
    const r = buildRows(t, { city: 0, state: 1, county: null, url: 2, altUrl: 3 });
    expect(r.rows.map((x) => x.fallback ?? false)).toEqual([true, false, false, true]);
    expect(r.rows[0].url).toContain('appid=0123456789abcdef');
    expect(r.rows[1].url).toBe('https://b.gov/x/MapServer'); // its own link wins
    expect(r.rows[2].url).toBe(''); // nothing anywhere: still URL_EMPTY
    expect(r.rows[3].url).toContain('home/item.html'); // text with no link is replaced too
  });

  it('suggestMapping does not turn it on by itself', () => {
    expect(suggestMapping(['City', 'State', 'REST', 'Viewer']).altUrl ?? null).toBeNull();
  });
});

describe('date-field suggestions (PRD 5.3)', () => {
  const r = (id: string, status: CheckResult['status'], other: string[], city = `City ${id}`) =>
    ({ id, status, city, state: 'TX', otherDateFields: other }) as unknown as CheckResult;
  const results = [
    r('1', 'OK_NO_DATE', ['Zoning.Ord_Date', 'Zoning.CreationDate']),
    r('2', 'OK_NO_DATE', ['Zoning Districts.ORD_DATE']),
    r('3', 'OK', ['Parcels.Ord_Date', 'Parcels.Last.Revised']),
    r('4', 'OK_NO_DATE', ['Z.AdoptedDate']),
    r('5', 'OK', ['Z.CreationDate']),
    r('6', 'OK_NO_DATE', ['Z.EditDate']), // already on the list
  ];
  const configured = new Set(['editdate', 'lastedited']);

  it('groups by normalized name across layers and cases, and counts maps that would gain a date', () => {
    const s = suggestDateFields(results, configured);
    const ord = s.find((x) => normalizeName(x.name) === 'orddate')!;
    expect(ord.maps).toBe(3);
    expect(ord.mapsWithoutDate).toBe(2);
    expect(ord.examples.length).toBeGreaterThan(0);
  });

  it('ranks likely update-style names first and creation-style names last, and skips names already configured', () => {
    const s = suggestDateFields(results, configured);
    expect(s.map((x) => x.name)).not.toContain('EditDate');
    expect(s[0].likelihood).toBe('likely');
    expect(s[s.length - 1].name).toBe('CreationDate');
    expect(s[s.length - 1].likelihood).toBe('unlikely');
  });

  it('classifies names', () => {
    expect(classifyFieldName('LastRevised')).toBe('likely');
    expect(classifyFieldName('AdoptedDate')).toBe('likely');
    expect(classifyFieldName('created_date')).toBe('unlikely');
    expect(classifyFieldName('SurveyDate')).toBe('unlikely');
    expect(classifyFieldName('Foo')).toBe('maybe');
    expect(classifyFieldName('last_created')).toBe('maybe'); // both signals: leave it to the analyst
  });

  it('takes the field name after the last dot, even when the layer name has dots', () => {
    expect(fieldOf('Zoning v2.1 (final).Ord_Date')).toBe('Ord_Date');
  });
});

describe('re-check maps that loaded without a date', () => {
  const mk = (id: string, fp: string): CheckRow => ({ id, sheetRow: Number(id), city: id, state: 'TX', county: '', url: 'https://a.gov/x/MapServer', fingerprint: fp, preIssues: [], extra: {} });
  const rows = [mk('2', 'a'), mk('3', 'b'), mk('4', 'c')];
  const stored = new Map<string, CheckResult>([
    ['a', { status: 'OK' } as CheckResult],
    ['b', { status: 'OK_NO_DATE' } as CheckResult],
    ['c', { status: 'TIMEOUT' } as CheckResult],
  ]);
  it('nodate mode queues only OK_NO_DATE maps (plus anything new)', () => {
    expect(planSync(rows, rows, stored, 'nodate').toCheck.map((r) => r.id)).toEqual(['3']);
    expect(planSync(rows, rows, stored, 'failed').toCheck.map((r) => r.id)).toEqual(['4']);
  });
});

describe('field-name ranking on names seen in real sheets', () => {
  it.each([
    ['MODDATE', 'likely'], ['DATEMOD', 'likely'], ['DATE_MOD', 'likely'], ['DATEMODIFI', 'likely'], ['Parcel_LASTUPDATE', 'likely'], ['DATE_ADOPT', 'likely'],
    ['GDB_FROM_DATE', 'unlikely'], ['GDB_DELETED_AT', 'unlikely'], ['CreationDate', 'unlikely'], ['SurveyDate', 'unlikely'],
    ['MODEL_DATE', 'maybe'], ['Rezone_Date', 'maybe'], ['Date', 'maybe'],
  ])('%s is %s', (name, expected) => {
    expect(classifyFieldName(name)).toBe(expected);
  });
});
