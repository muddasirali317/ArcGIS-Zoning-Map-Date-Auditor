/** PRD 12.1: date detector against fixtures: master list, epoch and string dates, sentinels, future dates. */
import { describe, expect, it } from 'vitest';
import { checkMap, fromEpochMs, normalizeName, parseDateStrings, resolveConfig, type Config } from '@zoning/core';
import { MockHttp, NOW, SVC, fixedNow, fixture, noSleep, rawConfig, reply, row, testConfig, zoningService } from './helpers';

// Copied from PRD 5.3, independent of config.json, so config drift is caught.
const PRD_MASTER_LIST = [
  'DateModified', 'Date_Modified', 'LastModified', 'Last_Modified', 'LastEditDate', 'Last_Edit_Date', 'EditDate', 'Edit_Date',
  'ModifiedDate', 'Modified_Date', 'LastUpdate', 'Last_Update', 'LastUpdated', 'Last_Updated', 'UpdateDate', 'Update_Date',
  'UpdatedDate', 'Updated_Date', 'DateUpdated', 'Date_Updated', 'LastEdited', 'Last_Edited', 'LastEdit', 'Last_Edit',
  'Date_Effective', 'DateEffective',
];

const deps = (http: MockHttp, config: Config = testConfig()) => ({ http, config, now: fixedNow, sleep: noSleep });
const ms = Date.UTC(2023, 4, 14, 16, 30);

describe('normalization', () => {
  it('lowercases and strips underscores, spaces and hyphens', () => {
    expect(normalizeName('Last_Edit_Date')).toBe('lasteditdate');
    expect(normalizeName('LASTEDITDATE')).toBe('lasteditdate');
    expect(normalizeName('lastEditDate')).toBe('lasteditdate');
    expect(normalizeName('last edit-date')).toBe('lasteditdate');
  });
});

describe('master list detection through the engine', () => {
  const variants = (name: string) => [name, name.toUpperCase(), name.toLowerCase(), name.replace(/_/g, ''), name.replace(/_/g, ' '), name.replace(/_/g, '-')];

  for (const name of PRD_MASTER_LIST) {
    it(`finds ${name} in every casing / separator form`, async () => {
      for (const v of variants(name)) {
        const res = await checkMap(row(SVC), deps(zoningService({ fieldName: v })));
        expect(res.status, v).toBe('OK');
        expect(res.primaryDate, v).toBe('2023-05-14');
        expect(res.dateSource, v).toBe(`Attribute:${v}`);
      }
    });
  }

  it('config.json contains every name from the PRD list', () => {
    const configured = new Set(rawConfig.dateFieldNames.map(normalizeName));
    for (const n of PRD_MASTER_LIST) expect(configured.has(normalizeName(n)), n).toBe(true);
  });

  it('PRD claim check: normalization alone does NOT cover Esri\'s last_edited_date, so config.json adds it', () => {
    const prdOnly = resolveConfig({ ...rawConfig, dateFieldNames: PRD_MASTER_LIST });
    expect(prdOnly.dateFields.has(normalizeName('last_edited_date'))).toBe(false);
    expect(testConfig().dateFields.has(normalizeName('last_edited_date'))).toBe(true);
  });

  it('reports a Date field that is not on the list under Other Date Fields Found, and never uses it as the date', async () => {
    const http = zoningService({ fieldName: 'Ord_Date' });
    const res = await checkMap(row(SVC), deps(http));
    expect(res.status).toBe('OK_NO_DATE');
    expect(res.primaryDate).toBe('None');
    expect(res.otherDateFields).toEqual(['Zoning Districts.Ord_Date']);
    expect(res.issueReason).toContain('Ord_Date');
  });
});

describe('real ArcGIS fixtures', () => {
  const W = 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/Wildfire/FeatureServer';
  const wildfire = () =>
    new MockHttp([
      [/\/0\/query\?/, () => reply(fixture('real/wildfire_stats_last_edited.json'))],
      [/\/FeatureServer\/0\?f=json$/, () => reply(fixture('real/wildfire_layer0.json'))],
      [/\/FeatureServer\?f=json$/, () => reply(fixture('real/wildfire_featureserver_root.json'))],
    ]);

  it('reads last_edited_date from a real layer via the statistics query', async () => {
    const stats = fixture('real/wildfire_stats_last_edited.json').features[0].attributes;
    const http = wildfire();
    const res = await checkMap(row(`${W}/0`), deps(http));
    const expected = new Date(stats.max_d).toISOString().slice(0, 10);
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe(expected);
    expect(res.dateSource).toBe('Attribute:last_edited_date');
    expect(res.attributeMaxDate).toBe(expected);
    expect(res.attributeMinDate).toBe(new Date(stats.min_d).toISOString().slice(0, 10));
    expect(res.dateConfidence).toBe('high');
    expect(res.evidenceUrl).toContain('outStatistics');
    expect(res.otherDateFields.sort()).toEqual(['Wildfire Response Points.created_date', 'Wildfire Response Points.eventdate']);
    expect(res.layers[0].nonNullCounts.last_edited_date).toBe(stats.nn_count);
  });

  it('finds the editor-tracking field through editFieldsInfo even when the name is not on the list', async () => {
    const cfg = testConfig({ dateFieldNames: PRD_MASTER_LIST });
    const res = await checkMap(row(`${W}/0`), deps(wildfire(), cfg));
    expect(res.dateSource).toBe('Attribute:last_edited_date');
  });

  it('a real MapServer layer with no date fields ends as OK_NO_DATE with the literal text None', async () => {
    const http = new MockHttp([
      [/\/MapServer\/3\?f=json$/, () => reply(fixture('real/census_layer3.json'))],
      [/\/MapServer\?f=json$/, () => reply(fixture('real/census_mapserver_root.json'))],
    ]);
    const res = await checkMap(row('https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer/3'), deps(http));
    expect(res.status).toBe('OK_NO_DATE');
    for (const k of ['primaryDate', 'dateSource', 'dateConfidence', 'attributeMaxDate', 'attributeMinDate', 'serviceEditingInfoDate'] as const) {
      expect(res[k], k).toBe('None');
    }
    expect(res.dateFieldName).toBe('Review Date'); // never left empty: the review date stands in
  });

  it('an ImageServer is checked from its metadata only (one request, no layers)', async () => {
    const http = new MockHttp([[/ImageServer\?f=json$/, () => reply(fixture('real/charlotte_imageserver_root.json'))]]);
    const res = await checkMap(row('https://sampleserver6.arcgisonline.com/arcgis/rest/services/CharlotteLAS/ImageServer'), deps(http));
    expect(http.calls).toHaveLength(1);
    expect(res.serviceType).toBe('ImageServer');
    expect(['OK', 'OK_NO_DATE']).toContain(res.status);
  });
});

describe('epoch dates', () => {
  const s = new Set(rawConfig.sentinelDates);
  it('converts to UTC and does not shift the day', () => {
    expect(fromEpochMs(Date.UTC(2023, 4, 14, 0, 0, 0), s)).toMatchObject({ kind: 'valid', date: '2023-05-14', iso: '2023-05-14T00:00:00.000Z' });
    expect(fromEpochMs(Date.UTC(2023, 4, 14, 23, 59, 59), s)).toMatchObject({ kind: 'valid', date: '2023-05-14' });
    expect(fromEpochMs(Date.UTC(2023, 11, 31, 23, 59, 59, 999), s)).toMatchObject({ kind: 'valid', date: '2023-12-31' });
  });

  it('the engine shows the UTC date whatever the machine time zone', async () => {
    const res = await checkMap(row(SVC), deps(zoningService({ statsMax: Date.UTC(2023, 4, 14, 0, 0, 1) })));
    expect(res.primaryDate).toBe('2023-05-14');
    expect(res.allDates.find((d) => d.role === 'max')?.iso).toBe('2023-05-14T00:00:01.000Z');
  });

  it.each([
    [0, 'epoch zero'],
    [-1, 'negative'],
    [-2209161600000, 'negative'], // 1899-12-30
    [-2208988800000, 'negative'], // 1900-01-01
    [3_600_000, '1970-01-01'], // positive, but still the 1970-01-01 default day
  ])('treats %d as a placeholder', (value) => {
    expect(fromEpochMs(value, s).kind).toBe('sentinel');
  });

  it('a sentinel maximum is ignored, logged, and gives None', async () => {
    for (const v of [0, -2209161600000]) {
      const res = await checkMap(row(SVC), deps(zoningService({ statsMax: v, statsMin: v })));
      expect(res.primaryDate).toBe('None');
      expect(res.status).toBe('OK_NO_DATE');
      expect(res.issues.map((i) => i.code)).toContain('DATE_SENTINEL_IGNORED');
    }
  });

  it('a sentinel minimum is ignored but a real maximum is still used', async () => {
    const res = await checkMap(row(SVC), deps(zoningService({ statsMin: 0 })));
    expect(res.primaryDate).toBe('2023-05-14');
    expect(res.attributeMinDate).toBe('None');
    expect(res.issues.map((i) => i.code)).toContain('DATE_SENTINEL_IGNORED');
  });

  it('keeps future dates and flags them DATE_IN_FUTURE', async () => {
    const future = Date.UTC(2027, 0, 15);
    const res = await checkMap(row(SVC), deps(zoningService({ statsMax: future })));
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2027-01-15');
    expect(res.issues.map((i) => i.code)).toContain('DATE_IN_FUTURE');
  });

  it('a layer whose date is null everywhere gives None (never blank, never 0)', async () => {
    const res = await checkMap(row(SVC), deps(zoningService({ statsMax: null, statsMin: null })));
    expect(res.primaryDate).toBe('None');
    expect(res.primaryDate).not.toBe('');
  });
});

describe('text dates', () => {
  const s = new Set(rawConfig.sentinelDates);
  const dates = (vals: string[]) => parseDateStrings(vals, s).valid.map((v) => v.date);

  it('parses the formats named in the PRD', () => {
    expect(dates(['2023/05/14', '2023-05-14', '20230514', '2023-05-14T10:20:30Z', '2023-05-14 10:20:30'])).toEqual(Array(5).fill('2023-05-14'));
    expect(dates(['5/14/2023', '05/14/2023'])).toEqual(['2023-05-14', '2023-05-14']);
    expect(dates(['May 14, 2023', '14 May 2023', 'Sept 3 2021'])).toEqual(['2023-05-14', '2023-05-14', '2021-09-03']);
  });

  it('ignores the time of day: a text date is never shifted by a zone', () => {
    expect(dates(['2023-05-14T23:59:59-08:00'])).toEqual(['2023-05-14']);
  });

  it('marks an isolated 03/04/2023 as ambiguous instead of guessing', () => {
    const p = parseDateStrings(['03/04/2023'], s);
    expect(p.valid).toEqual([]);
    expect(p.ambiguous).toEqual(['03/04/2023']);
  });

  it('settles day/month order from the rest of the same field', () => {
    expect(dates(['03/04/2023', '05/14/2023'])).toEqual(['2023-03-04', '2023-05-14']); // 14 proves M/D/Y
    expect(dates(['03/04/2023', '25/12/2022'])).toEqual(['2023-04-03', '2022-12-25']); // 25 proves D/M/Y
  });

  it('rejects impossible dates and unknown text', () => {
    const p = parseDateStrings(['2023-02-30', '13/13/2023', 'TBD'], s);
    expect(p.valid).toEqual([]);
    expect(p.unparsed.length + p.ambiguous.length).toBe(3);
  });

  it('flags placeholder text dates', () => {
    expect(parseDateStrings(['1900-01-01', '1899-12-30'], s).sentinels).toHaveLength(2);
  });

  it('reads month-name dates with any separator and the ordinal suffix', () => {
    expect(dates(['14-May-2023', 'May-14-2023', '14.May.2023', 'May/14/2023', 'May 14th, 2023', '14th May 2023']))
      .toEqual(Array(6).fill('2023-05-14'));
    expect(dates(['14-MAY-2023', '3-SEP-2021'])).toEqual(['2023-05-14', '2021-09-03']); // Oracle/Esri display form
  });

  it('expands two-digit years: 00–69 → 2000s, 70–99 → 1900s', () => {
    expect(dates(['14-May-23', 'May 14 23'])).toEqual(['2023-05-14', '2023-05-14']);
    expect(dates(['14-May-99', '14-May-70'])).toEqual(['1999-05-14', '1970-05-14']);
    expect(dates(['5/14/23'])).toEqual(['2023-05-14']); // the 14 proves M/D/Y
    expect(dates(['25/12/99'])).toEqual(['1999-12-25']); // the 25 proves D/M/Y
  });

  it('a two-digit-year numeric date with no order proof stays ambiguous, never guessed', () => {
    const p = parseDateStrings(['03/04/23'], s);
    expect(p.valid).toEqual([]);
    expect(p.ambiguous).toEqual(['03/04/23']);
  });

  it('strips wrapping quotes, brackets and non-breaking / zero-width spaces', () => {
    expect(dates(['"2023-05-14"', '[2023-05-14]', '(14-May-2023)', ' 2023-05-14 ', '​2023-05-14'])).toEqual(Array(5).fill('2023-05-14'));
  });

  it('rescues epoch seconds (not just milliseconds) for modern dates', () => {
    const msValue = Date.UTC(2023, 4, 14); // 1684022400000
    expect(fromEpochMs(msValue / 1000, s)).toMatchObject({ kind: 'valid', date: '2023-05-14' }); // given as seconds
    expect(fromEpochMs(msValue, s)).toMatchObject({ kind: 'valid', date: '2023-05-14' }); // given as ms
    // a small millisecond value that is still the 1970 default day is left as a sentinel, not rescaled
    expect(fromEpochMs(3_600_000, s).kind).toBe('sentinel');
  });

  it('uses the latest text date of a text field via the engine, in the service JSON order-independent way', async () => {
    const http = new MockHttp([
      [/\/query\?/, () => reply({ features: ['5/14/2023', '11/2/2021', '7/30/2022'].map((v) => ({ attributes: { LastUpdated: v } })) })],
      [/\/MapServer\/0\?f=json$/, () => reply({ id: 0, name: 'Zoning', type: 'Feature Layer', capabilities: 'Map,Query', fields: [{ name: 'LastUpdated', type: 'esriFieldTypeString' }] })],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }] })],
    ]);
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2023-05-14');
    expect(res.dateSource).toBe('Attribute:LastUpdated');
  });

  it('an ambiguous text field raises AMBIGUOUS_FORMAT and yields no date', async () => {
    const http = new MockHttp([
      [/\/query\?/, () => reply({ features: [{ attributes: { LastUpdated: '03/04/2023' } }] })],
      [/\/MapServer\/0\?f=json$/, () => reply({ id: 0, name: 'Zoning', type: 'Feature Layer', fields: [{ name: 'LastUpdated', type: 'esriFieldTypeString' }] })],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }] })],
    ]);
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('None');
    expect(res.issues.map((i) => i.code)).toContain('AMBIGUOUS_FORMAT');
  });
});

describe('where dates are looked for', () => {
  it('default: the Primary Date is the attribute date even when the last edit date is newer; both are kept', async () => {
    const http = zoningService({ editingInfo: { lastEditDate: Date.UTC(2024, 0, 2), dataLastEditDate: Date.UTC(2024, 0, 1) } });
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2023-05-14');
    expect(res.dateSource).toBe('Attribute:LAST_EDIT_DATE');
    expect(res.serviceEditingInfoDate).toBe('2024-01-02'); // lastEditDate, not the older dataLastEditDate
    expect(res.attributeMaxDate).toBe('2023-05-14');
    expect(res.allDates.map((d) => d.source)).toEqual(expect.arrayContaining(['Service:editingInfo', 'Attribute:LAST_EDIT_DATE']));
  });

  it('dateSelection "latest" still picks the newest of the attribute max and the last edit date', async () => {
    const http = zoningService({ editingInfo: { lastEditDate: Date.UTC(2024, 0, 2), dataLastEditDate: Date.UTC(2024, 0, 1) } });
    const res = await checkMap(row(SVC), deps(http, testConfig({ dateSelection: 'latest' })));
    expect(res.primaryDate).toBe('2024-01-02');
    expect(res.dateSource).toBe('Service:editingInfo');
    expect(res.dateFieldName).toBe('lastEditDate');
  });

  it('default: when lastEditDate and dataLastEditDate are equal, the field is reported as lastEditDate', async () => {
    const same = Date.UTC(2025, 2, 3);
    const res = await checkMap(row(SVC), deps(zoningService({ fieldName: 'Ord_Date', editingInfo: { dataLastEditDate: same, lastEditDate: same } })));
    expect(res.dateFieldName).toBe('lastEditDate');
  });

  it('default: an attribute date newer than the last edit date wins, and a tie keeps the attribute', async () => {
    const newer = await checkMap(row(SVC), deps(zoningService({ statsMax: Date.UTC(2025, 5, 1), editingInfo: { lastEditDate: Date.UTC(2024, 0, 2) } })));
    expect(newer.primaryDate).toBe('2025-06-01');
    expect(newer.dateSource).toBe('Attribute:LAST_EDIT_DATE');
    const tie = await checkMap(row(SVC), deps(zoningService({ statsMax: Date.UTC(2024, 0, 2, 5), editingInfo: { lastEditDate: Date.UTC(2024, 0, 2, 20) } })));
    expect(tie.dateSource).toBe('Attribute:LAST_EDIT_DATE');
  });

  it('keeps the attribute date as Primary even when the endpoint metadata date is later (metadata is only a fallback)', async () => {
    const http = new MockHttp([
      [/\/query\?/, () => reply({ features: [{ attributes: { max_d: Date.UTC(2023, 4, 14), min_d: Date.UTC(2019, 0, 3), nn_count: 120 } }] })],
      [/\/MapServer\/0\?f=json$/, () => reply({ id: 0, name: 'Zoning', type: 'Feature Layer', fields: [{ name: 'EditDate', type: 'esriFieldTypeDate' }] })],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }], LastModified: Date.UTC(2025, 0, 6) })],
    ]);
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2023-05-14');
    expect(res.dateSource).toBe('Attribute:EditDate');
    expect(res.allDates.some((d) => d.source === 'Service:LastModified' && d.date === '2025-01-06')).toBe(true); // still listed as evidence
  });

  it('dateSelection "priority": the first source in datePriority wins even when older', async () => {
    const http = zoningService({ editingInfo: { lastEditDate: Date.UTC(2024, 0, 2) } });
    const res = await checkMap(row(SVC), deps(http, testConfig({ dateSelection: 'priority' })));
    expect(res.primaryDate).toBe('2023-05-14');
    expect(res.dateSource).toBe('Attribute:LAST_EDIT_DATE');
  });

  it('falls back to service editingInfo when no attribute date exists', async () => {
    const http = zoningService({ fieldName: 'Ord_Date', editingInfo: { dataLastEditDate: Date.UTC(2024, 0, 1) } });
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2024-01-01');
    expect(res.dateSource).toBe('Service:editingInfo');
  });

  it('in priority mode the order is configurable', async () => {
    const http = zoningService({ editingInfo: { dataLastEditDate: Date.UTC(2020, 0, 1) } });
    const cfg = testConfig({ dateSelection: 'priority', datePriority: ['editingInfo', 'attribute', 'serviceProperty', 'portalItem'] });
    const res = await checkMap(row(SVC), deps(http, cfg));
    expect(res.primaryDate).toBe('2020-01-01');
  });

  it('reads a date-named property from service metadata', async () => {
    const http = new MockHttp([
      [/\/MapServer\/0\?f=json$/, () => reply({ id: 0, name: 'Zoning', type: 'Feature Layer', fields: [] })],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }], documentInfo: { Title: 'Zoning', LastModified: Date.UTC(2022, 2, 9) } })],
    ]);
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2022-03-09');
    expect(res.dateSource).toBe('Service:documentInfo.LastModified');
    expect(res.dateConfidence).toBe('medium');
  });

  it('a schema-only edit date is recorded but never becomes the Primary Date', async () => {
    const http = zoningService({ fieldName: 'Ord_Date', editingInfo: { schemaLastEditDate: Date.UTC(2024, 5, 1) } });
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('None');
    expect(res.allDates.some((d) => d.date === '2024-06-01')).toBe(true);
  });

  it('statistics unsupported: falls back to ordering by the field', async () => {
    const layerJson = { id: 0, name: 'Zoning', type: 'Feature Layer', advancedQueryCapabilities: { supportsStatistics: false }, fields: [{ name: 'EditDate', type: 'esriFieldTypeDate' }] };
    const http = new MockHttp([
      [(u) => u.includes('DESC'), () => reply({ features: [{ attributes: { EditDate: Date.UTC(2021, 6, 4) } }] })],
      [(u) => u.includes('ASC'), () => reply({ features: [{ attributes: { EditDate: Date.UTC(2015, 0, 1) } }] })],
      [/\/MapServer\/0\?f=json$/, () => reply(layerJson)],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }] })],
    ]);
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2021-07-04');
    expect(res.attributeMinDate).toBe('2015-01-01');
    expect(http.calls.some((u) => u.includes('outStatistics'))).toBe(false);
  });

  it('statistics request fails with an ArcGIS error: falls back to ordering', async () => {
    const http = new MockHttp([
      [(u) => u.includes('outStatistics'), () => reply({ error: { code: 400, message: 'Unable to complete operation.' } })],
      [(u) => u.includes('DESC'), () => reply({ features: [{ attributes: { LAST_EDIT_DATE: Date.UTC(2021, 6, 4) } }] })],
      [(u) => u.includes('ASC'), () => reply({ features: [{ attributes: { LAST_EDIT_DATE: Date.UTC(2015, 0, 1) } }] })],
      [/\/MapServer\/0\?f=json$/, () => reply(zoningLayer())],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }] })],
    ]);
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2021-07-04');
  });

  it('checks every layer but takes the attribute date from the zoning layer, not a newer unrelated layer', async () => {
    const mk = (id: number, name: string, fields: any[]) => ({ id, name, type: 'Feature Layer', capabilities: 'Query', fields });
    const date = [{ name: 'LastEditDate', type: 'esriFieldTypeDate' }];
    const http = new MockHttp([
      [/\/0\/query\?/, () => reply({ features: [{ attributes: { max_d: Date.UTC(2025, 1, 2), min_d: Date.UTC(2020, 0, 1), nn_count: 9 } }] })],
      [/\/2\/query\?/, () => reply({ features: [{ attributes: { max_d: Date.UTC(2024, 1, 2), min_d: Date.UTC(2020, 0, 1), nn_count: 9 } }] })],
      [/\/1\/query\?/, () => reply({ features: [{ attributes: { max_d: Date.UTC(2010, 1, 2), min_d: Date.UTC(2010, 0, 1), nn_count: 9 } }] })],
      [/\/MapServer\/0\?f=json$/, () => reply(mk(0, 'Parcels', date))],
      [/\/MapServer\/1\?f=json$/, () => reply(mk(1, 'Streets', date))],
      [/\/MapServer\/2\?f=json$/, () => reply(mk(2, 'Zoning Districts', date))],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Parcels' }, { id: 1, name: 'Streets' }, { id: 2, name: 'Zoning Districts' }] })],
    ]);
    const res = await checkMap(row(SVC), deps(http));
    expect(res.primaryDate).toBe('2024-02-02'); // Zoning Districts; "Parcels" (2025) is newer but is not the zoning layer
    expect(res.dateSource).toBe('Attribute:LastEditDate');
    expect(res.zoningLayerName).toBe('Zoning Districts');
    expect(res.layersChecked).toBe(3);
    expect(http.calls.some((u) => u.includes('/MapServer/0'))).toBe(true);
  });

  it('respects the per-map layer cap', async () => {
    const layers = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Layer ${i}` }));
    const http = new MockHttp([
      [/\/MapServer\/\d+\?f=json$/, (u) => reply({ id: Number(/MapServer\/(\d+)/.exec(u)![1]), name: 'x', type: 'Feature Layer', fields: [] })],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers })],
    ]);
    const res = await checkMap(row(SVC), deps(http, testConfig({ maxLayersPerMap: 25 })));
    expect(res.layersChecked).toBe(25);
  });
});

function zoningLayer() {
  return { id: 0, name: 'Zoning', type: 'Feature Layer', capabilities: 'Map,Query', advancedQueryCapabilities: { supportsStatistics: true }, fields: [{ name: 'LAST_EDIT_DATE', type: 'esriFieldTypeDate' }] };
}

describe('stamps', () => {
  it('stamps the review date with the local calendar date and records the check time in UTC', async () => {
    const res = await checkMap(row(SVC), deps(zoningService()));
    expect(res.reviewDate).toBe(`${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(NOW.getDate()).padStart(2, '0')}`);
    expect(res.reviewedAt).toBe(NOW.toISOString());
    expect(res.toolVersion).toMatch(/phase1/);
  });
});
