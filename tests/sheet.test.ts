/** PRD 12.3: sheet tests: blank rows, duplicate URLs, multi-URL cells, extra text around URLs, wrong tab. */
import { describe, expect, it } from 'vitest';
import { assertCsvResponse, buildRows, csvExportUrl, extractUrls, fingerprint, normalizeUrl, parseCsv, parseSheetUrl, SheetError, suggestMapping } from '@zoning/core';

const build = (csv: string) => {
  const table = parseCsv(csv);
  const mapping = suggestMapping(table[0], table.slice(1));
  return { table, mapping, ...buildRows(table, mapping) };
};

describe('sheet link', () => {
  it('extracts the sheet id and gid from every common link shape', () => {
    const id = '1AbC_dEf-123456789';
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=1234`)).toEqual({ sheetId: id, gid: '1234' });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=77&usp=sharing`)).toEqual({ sheetId: id, gid: '77' });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`)).toEqual({ sheetId: id, gid: '0' });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}`)).toEqual({ sheetId: id, gid: '0' });
  });

  it('builds the CSV export URL from the PRD', () => {
    expect(csvExportUrl({ sheetId: 'ABC', gid: '5' })).toBe('https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=5');
  });

  it('rejects links that are not Google Sheets', () => {
    expect(() => parseSheetUrl('https://example.com/sheet')).toThrow(SheetError);
    expect(() => parseSheetUrl('')).toThrow(SheetError);
  });

  it('a private sheet (HTML sign-in page, 401/403) gives the clear message from the PRD', () => {
    for (const [status, body] of [[200, '<!DOCTYPE html><html><head><title>Sign in</title>'], [401, ''], [403, 'x'], [200, '  <html>']] as const) {
      expect(() => assertCsvResponse(status, body)).toThrow('Sheet is private. Share as "Anyone with the link" or sign in with Google.');
    }
    expect(() => assertCsvResponse(200, 'City,State\nA,TX')).not.toThrow();
    expect(() => assertCsvResponse(404, 'x')).toThrow(SheetError);
  });
});

describe('CSV parsing', () => {
  it('handles quotes, commas, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const t = parseCsv('﻿City,Note\r\n"Smith, Town","He said ""hi"""\r\n"Multi\nLine",ok\r\n');
    expect(t).toEqual([['City', 'Note'], ['Smith, Town', 'He said "hi"'], ['Multi\nLine', 'ok']]);
  });
  it('keeps a final line with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('column auto-mapping', () => {
  it('maps the PRD synonyms, case-insensitively', () => {
    expect(suggestMapping(['MUNICIPALITY', 'ST', 'County Name', 'Endpoint'])).toEqual({ city: 0, state: 1, county: 2, url: 3 });
    expect(suggestMapping(['City', 'State', 'County', 'Link'])).toEqual({ city: 0, state: 1, county: 2, url: 3 });
    expect(suggestMapping(['city / town', 'state', 'zoning map url'])).toMatchObject({ city: 0, state: 1, url: 2 });
  });
  it('handles headers decorated with counts and plurals, as in the analyst sheet', () => {
    const h = ['182 - IDs', '183 - Cities', '104 - Counties', '10 - States', 'TML: 183 | NMF: 0', '171 - Endpoint_Links', 'FLUM_Link'];
    expect(suggestMapping(h)).toEqual({ city: 1, state: 3, county: 2, url: 5 });
  });
  it('does not take a "City Map URL" column as the city', () => {
    const m = suggestMapping(['City', 'City Map URL', 'State']);
    expect(m.url).toBe(1);
    expect(m.city).toBe(0);
  });
  it('falls back to the column that contains links when no header matches', () => {
    const t = parseCsv('Place,Region,Stuff\nA,TX,https://x.gov/arcgis/rest/services/Z/MapServer\nB,TX,https://y.gov/arcgis/rest/services/Z/MapServer');
    expect(suggestMapping(t[0], t.slice(1)).url).toBe(2);
  });
});

describe('cleaning', () => {
  it('trims, removes zero-width characters and non-breaking spaces, and drops blank rows', () => {
    const r = build('City,State,County,URL\n​Austin  ,﻿TX, Travis ,https://gis.austin.gov/arcgis/rest/services/Z/MapServer\n,,,\n   ,  ,  ,  \n');
    expect(r.rows).toHaveLength(1);
    expect(r.blankDropped).toBe(2);
    expect(r.rows[0]).toMatchObject({ city: 'Austin', state: 'TX', county: 'Travis', sheetRow: 2, url: 'https://gis.austin.gov/arcgis/rest/services/Z/MapServer' });
  });

  it('extracts the URL from a cell with extra text', () => {
    const r = build('City,State,URL\nA,TX,"Zoning map: https://gis.a.gov/arcgis/rest/services/Z/MapServer (updated 2023)."\nB,TX,See https://gis.b.gov/arcgis/rest/services/Z/FeatureServer/0.');
    expect(r.rows.map((x) => x.url)).toEqual(['https://gis.a.gov/arcgis/rest/services/Z/MapServer', 'https://gis.b.gov/arcgis/rest/services/Z/FeatureServer/0']);
  });

  it('keeps URLs whose query contains parentheses or commas intact', () => {
    expect(extractUrls('x https://a.gov/p?q=(1,2)&z=1 y')).toEqual(['https://a.gov/p?q=(1,2)&z=1']);
  });

  it('splits a cell holding several URLs into separate checks on the same sheet row', () => {
    const r = build('City,State,URL\nA,TX,"https://gis.a.gov/arcgis/rest/services/Z/MapServer\nhttps://gis.a.gov/arcgis/rest/services/Y/MapServer; https://gis.a.gov/arcgis/rest/services/X/MapServer"\nB,TX,https://gis.b.gov/arcgis/rest/services/Z/MapServer');
    expect(r.rows.map((x) => x.id)).toEqual(['2.1', '2.2', '2.3', '3']);
    expect(r.rows.every((x) => x.sheetRow === (x.id.startsWith('2') ? 2 : 3))).toBe(true);
    expect(r.split).toBe(2);
    expect(new Set(r.rows.filter((x) => x.sheetRow === 2).map((x) => x.city))).toEqual(new Set(['A']));
  });

  it('keeps rows with a city but no usable link so they can report URL_EMPTY / URL_MALFORMED', () => {
    const r = build('City,State,URL\nA,TX,\nB,TX,coming soon');
    expect(r.rows).toHaveLength(2);
    expect(normalizeUrl(r.rows[0].url)).toMatchObject({ ok: false, code: 'URL_EMPTY' });
    expect(normalizeUrl(r.rows[1].url)).toMatchObject({ ok: false, code: 'URL_MALFORMED' });
  });

  it('keeps every original cell for the sheet-ready export', () => {
    const r = build('City,State,URL,Extra Col\nA,TX,https://gis.a.gov/arcgis/rest/services/Z/MapServer,keep me');
    expect(r.rows[0].extra).toMatchObject({ 'Extra Col': 'keep me', City: 'A' });
  });
});

describe('duplicates', () => {
  it('flags every occurrence with DUPLICATE_URL, keeps all rows, and names the rows', () => {
    const r = build(
      [
        'City,State,URL',
        'A,TX,https://gis.a.gov/arcgis/rest/services/Z/MapServer',
        'B,TX,https://gis.b.gov/arcgis/rest/services/Z/MapServer',
        'A2,TX,HTTPS://GIS.A.GOV/arcgis/rest/services/Z/MapServer/?f=json#x',
        'C,TX,https://gis.a.gov/arcgis/rest/services/Z/MapServer/0',
      ].join('\n'),
    );
    expect(r.rows).toHaveLength(4);
    expect(r.rows.map((x) => x.preIssues.length)).toEqual([1, 0, 1, 0]);
    expect(r.rows[0].preIssues[0]).toMatchObject({ code: 'DUPLICATE_URL' });
    expect(r.rows[0].preIssues[0].reason).toContain('row 2');
    expect(r.rows[0].preIssues[0].reason).toContain('row 4');
    expect(r.duplicates).toBe(2);
  });
});

describe('wrong tab', () => {
  it('a tab with no link column is detected (mapping.url is null) so the mapping screen can ask', () => {
    const r = build('Notes,Owner\nremember to call,Sam\nreview in May,Alex');
    expect(r.mapping.url).toBeNull();
  });

  it('a link column that is mapped but empty yields URL_EMPTY rows, never a silent success', () => {
    const r = build('City,State,Map URL\nA,TX,\nB,TX,');
    expect(r.rows.map((x) => normalizeUrl(x.url).ok)).toEqual([false, false]);
  });
});

describe('fingerprints (used by re-sync)', () => {
  it('are stable, ignore case/space, and change when city, state or URL change', () => {
    const base = fingerprint('Austin', 'TX', 'https://a.gov/x');
    expect(fingerprint(' austin ', 'tx', 'https://A.gov/x')).toBe(base);
    expect(fingerprint('Austin', 'OK', 'https://a.gov/x')).not.toBe(base);
    expect(fingerprint('Austin', 'TX', 'https://a.gov/y')).not.toBe(base);
    expect(fingerprint('Dallas', 'TX', 'https://a.gov/x')).not.toBe(base);
  });
});

describe('URL normalization', () => {
  it('reduces service, layer and viewer-decorated links to the service root', () => {
    const cases: [string, string, number | undefined][] = [
      ['https://gis.a.gov/arcgis/rest/services/Z/MapServer', 'https://gis.a.gov/arcgis/rest/services/Z/MapServer', undefined],
      ['https://gis.a.gov/arcgis/rest/services/Z/MapServer/', 'https://gis.a.gov/arcgis/rest/services/Z/MapServer', undefined],
      ['https://gis.a.gov/arcgis/rest/services/Z/MapServer?f=pjson', 'https://gis.a.gov/arcgis/rest/services/Z/MapServer', undefined],
      ['https://gis.a.gov/arcgis/rest/services/Z/MapServer#/viewer', 'https://gis.a.gov/arcgis/rest/services/Z/MapServer', undefined],
      ['https://gis.a.gov/arcgis/rest/services/Z/MapServer/3', 'https://gis.a.gov/arcgis/rest/services/Z/MapServer', 3],
      ['https://gis.a.gov/arcgis/rest/services/Z/FeatureServer/0/query?where=1=1&token=SECRET', 'https://gis.a.gov/arcgis/rest/services/Z/FeatureServer', 0],
      ['gis.a.gov/arcgis/rest/services/Z/mapserver', 'https://gis.a.gov/arcgis/rest/services/Z/mapserver', undefined],
    ];
    for (const [input, service, layer] of cases) {
      const n = normalizeUrl(input);
      expect(n.ok, input).toBe(true);
      if (n.ok) {
        expect(n.serviceUrl, input).toBe(service);
        expect(n.layerId, input).toBe(layer);
      }
    }
  });

  it('never keeps a token from the pasted link', () => {
    const n = normalizeUrl('https://gis.a.gov/arcgis/rest/services/Z/MapServer?token=SECRET123');
    expect(JSON.stringify(n)).not.toContain('SECRET123');
  });

  it('recognises folders and app links, and pulls the item id', () => {
    expect(normalizeUrl('https://gis.a.gov/arcgis/rest/services')).toMatchObject({ ok: true, kind: 'Folder' });
    expect(normalizeUrl('https://gis.a.gov/arcgis/rest/services/Planning/')).toMatchObject({ ok: true, kind: 'Folder' });
    const app = normalizeUrl('https://city.maps.arcgis.com/apps/webappviewer/index.html?id=0123456789ABCDEF0123456789abcdef');
    expect(app).toMatchObject({ ok: true, kind: 'AppUrl', itemId: '0123456789abcdef0123456789abcdef' });
  });
});
