import { describe, expect, it } from 'vitest';
import { buildCopyTable, buildRows, COPY_COLUMNS, type CheckResult } from '@zoning/core';

const table = [
  ['id', 'City', 'County', 'State', 'Map URL', 'Old date', 'New date', 'Notes'],
  ['A1', 'Chicago', 'Cook', 'IL', 'https://gis.example.gov/arcgis/rest/services/Zoning/MapServer', '01-01-2020', '15-03-2021', 'secret note'],
  ['', '', '', '', '', '', '', ''],
  ['', 'Austin', 'Travis', 'TX', 'https://gis.example2.gov/arcgis/rest/services/Zoning/MapServer', '', '', ''],
];
const mapping = { city: 1, state: 3, county: 2, url: 4, altUrl: null };

describe('Review & copy table', () => {
  const built = buildRows(table, mapping);
  const results: Record<string, CheckResult> = {};
  const first = built.rows[0];
  results[first.id] = {
    id: first.id, sheetRow: first.sheetRow, city: 'Chicago', state: 'IL', county: 'Cook', status: 'OK', issues: [], issueReason: '',
    primaryDate: '2023-05-02', reviewDate: '2026-10-23', allDates: [],
  } as unknown as CheckResult;
  const out = buildCopyTable(table, built.rows, results, mapping, 'iso');

  it('has exactly the requested columns and nothing from the rest of the sheet', () => {
    expect(out[0]).toEqual([...COPY_COLUMNS]);
    expect(out.flat()).not.toContain('secret note');
    expect(out.flat()).not.toContain('Map URL');
  });
  it('fills id, city, county, state, old/new date from the sheet and the audit columns from the result', () => {
    expect(out[1]).toEqual(['A1', 'Chicago', 'Cook', 'IL', '01-01-2020', '15-03-2021', '2023-05-02', '2026-10-23', 'Updation', '']);
  });
  it('keeps blank lines so a paste cannot shift rows, and never invents an id', () => {
    expect(out[2]).toEqual(Array(COPY_COLUMNS.length).fill(''));
    expect(out[3][0]).toBe('');
    expect(out[3].slice(1, 4)).toEqual(['Austin', 'Travis', 'TX']);
  });
});
