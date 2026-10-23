/** Phase 3: viewer / app link resolution (PRD 5.1, 5.2 step 4), against saved real ArcGIS Online items. */
import { describe, expect, it } from 'vitest';
import { checkMap, extractRefs, HttpError, isBasemapUrl, normalizeUrl, portalBases, type HttpResponse } from '@zoning/core';
import { fixedNow, fixture, MockHttp, noSleep, reply, row, testConfig } from './helpers';

const P = (name: string) => fixture(`real/portal/${name}.json`);
const APP = { item: P('webapp_configurable.item'), data: P('webapp_configurable.data') };
const WEBMAP = { item: P('webmap_landuse.item'), data: P('webmap_landuse.data') };
const EXP = { item: P('experience_york.item'), data: P('experience_york.data') };
const DASH = { item: P('dashboard_zone3.item'), data: P('dashboard_zone3.data') };
const WEBMAP_ID = WEBMAP.item.id as string;

type Pair = { item: any; data: any };
const deps = (http: MockHttp, over = {}) => ({ http, config: testConfig(over), now: fixedNow, sleep: noSleep });

/** Portal item + data routes, plus a generic ArcGIS service answer for any host. */
function world(items: Record<string, Pair>, opts: { portalHost?: RegExp; serviceDate?: number | null; services?: (url: string) => HttpResponse | undefined } = {}) {
  const portal = opts.portalHost ?? /./;
  const date = opts.serviceDate === undefined ? Date.UTC(2025, 5, 5) : opts.serviceDate;
  return new MockHttp([
    [(u) => /\/sharing\/rest\/content\/items\/[0-9a-f]{32}\/data\?f=json$/.test(u) && portal.test(u), (u) => reply(items[/items\/([0-9a-f]{32})\//.exec(u)![1]]?.data ?? { error: { code: 400, message: 'Item does not exist or is inaccessible.' } })],
    [(u) => /\/sharing\/rest\/content\/items\/[0-9a-f]{32}\?f=json$/.test(u) && portal.test(u), (u) => {
      const hit = items[/items\/([0-9a-f]{32})\?/.exec(u)![1]];
      return reply(hit ? hit.item : { error: { code: 400, messageCode: 'CONT_0001', message: 'Item does not exist or is inaccessible.' } });
    }],
    [(u) => !!opts.services?.(u), (u) => opts.services!(u)!],
    [/\/query\?/, () => reply({ features: [{ attributes: { max_d: date, min_d: Date.UTC(2015, 0, 1), nn_count: 5 } }] })],
    [/\/(Map|Feature)Server\/\d+\?f=json$/, () => reply({ id: 0, name: 'Layer', type: 'Feature Layer', capabilities: 'Query', fields: date === null ? [] : [{ name: 'LastEditDate', type: 'esriFieldTypeDate' }] })],
    [/\/(Map|Feature)Server\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning' }] })],
  ]);
}

describe('reading real items', () => {
  it('a configurable app points at its web map (strong id); no service URLs in the app itself', () => {
    const r = extractRefs(APP.item, APP.data);
    expect(r.services).toEqual([]);
    expect(r.children).toEqual([{ id: 'b6c2a1c55c1b46e2a34a66b2249f409f', strong: true }]);
  });

  it('a web map lists its operational layers with titles, and drops base-map services', () => {
    const r = extractRefs(WEBMAP.item, WEBMAP.data);
    expect(r.services.map((s) => s.title)).toEqual(['SLUP 2025', 'Zoning', 'Historic Districts']);
    expect(r.services[1].url).toBe('https://maps9.stlouis-mo.gov/arcgis/rest/services/PDA/Zoning/MapServer');
    expect(r.services.every((s) => !isBasemapUrl(s.url))).toBe(true);
    expect(JSON.stringify(r.services)).not.toContain('Hillshade');
  });

  it('an Experience Builder app yields its layer services and only weak child ids', () => {
    const r = extractRefs(EXP.item, EXP.data);
    expect(r.services.length).toBeGreaterThanOrEqual(4);
    expect(r.services.every((s) => /FeatureServer\/\d+$/.test(s.url))).toBe(true);
    expect(r.children.length).toBeGreaterThan(0);
    expect(r.children.every((c) => !c.strong)).toBe(true);
  });

  it('a dashboard only carries an item id', () => {
    const r = extractRefs(DASH.item, DASH.data);
    expect(r.services).toEqual([]);
    expect(r.children.map((c) => c.id)).toContain('df0449da5d83499a8c0a6528325be2f4');
  });

  it('a service item is its own reference', () => {
    const r = extractRefs({ id: 'a'.repeat(32), type: 'Feature Service', title: 'Zoning', url: 'https://services1.arcgis.com/X/arcgis/rest/services/Zoning/FeatureServer' }, null);
    expect(r.services).toEqual([{ url: 'https://services1.arcgis.com/X/arcgis/rest/services/Zoning/FeatureServer', title: 'Zoning', from: 'a'.repeat(32) }]);
  });
});

describe('portal roots', () => {
  it('organisation sites try themselves, then www.arcgis.com', () => {
    expect(portalBases('https://floridadisaster.maps.arcgis.com/apps/instant/lookup/index.html?appid=x')).toEqual(['https://floridadisaster.maps.arcgis.com', 'https://www.arcgis.com']);
    expect(portalBases('https://experience.arcgis.com/experience/abc')).toEqual(['https://www.arcgis.com']);
  });
  it('enterprise portals try the web adaptor first', () => {
    expect(portalBases('https://maps.urbanail.gov/portalwebadaptor/apps/instant/lookup/index.html?appid=x')).toEqual([
      'https://maps.urbanail.gov/portalwebadaptor', 'https://maps.urbanail.gov/portal', 'https://maps.urbanail.gov', 'https://www.arcgis.com',
    ]);
  });
});

describe('resolving a viewer link through the engine', () => {
  const appUrl = 'https://floridadisaster.maps.arcgis.com/apps/instant/lookup/index.html?appid=aa18a2d8737c4d66bb6434a09e17203a';
  const items: Record<string, Pair> = {
    [APP.item.id]: { item: APP.item, data: { ...APP.data, values: { ...APP.data.values, webmap: WEBMAP_ID } } },
    [WEBMAP_ID]: WEBMAP,
  };

  it('app -> web map -> best zoning service: reads its date, reports the chain, and the portal date as a separate low-confidence value', async () => {
    const http = world(items);
    const res = await checkMap(row(appUrl), deps(http));
    expect(res.status).toBe('OK');
    expect(res.normalizedUrl).toBe('https://maps9.stlouis-mo.gov/arcgis/rest/services/PDA/Zoning/MapServer'); // "Zoning" outranks "SLUP 2025"
    expect(res.primaryDate).toBe('2025-06-05');
    expect(res.dateSource).toBe('Attribute:LastEditDate');
    expect(res.serviceType).toBe('App → MapServer');
    expect(res.resolvedFrom).toContain('Web Mapping Application "Know Your Zone" → Web Map "Land Use" → https://maps9.stlouis-mo.gov');
    expect(res.itemModifiedDate).toBe('2026-08-18'); // the web map's modified date, shown separately
    expect(res.layersChecked).toBe(3); // checks each of the three selected services for a newer date
    // the first portal tried (the org site) did not have the item; www.arcgis.com did
    expect(http.calls[0]).toContain('floridadisaster.maps.arcgis.com');
  });

  it('item dates are the last resort: used only when nothing else has a date, labelled low confidence', async () => {
    const res = await checkMap(row(appUrl), deps(world(items, { serviceDate: null })));
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2026-08-18');
    expect(res.dateSource).toBe('Portal:item.modified');
    expect(res.dateConfidence).toBe('low');
  });

  it('the app item itself is listed but never becomes the Primary Date', async () => {
    const res = await checkMap(row(appUrl), deps(world(items, { serviceDate: null })));
    const appDate = new Date(APP.item.modified).toISOString().slice(0, 10);
    const ev = res.allDates.find((d) => d.date === appDate && d.source === 'Portal:item.modified');
    expect(ev).toBeDefined();
    expect(ev!.primaryEligible).toBe(false);
  });

  it('a non-app link reports None for the item date', async () => {
    const res = await checkMap(row('https://gis.testville.gov/arcgis/rest/services/Z/MapServer'), deps(world(items)));
    expect(res.itemModifiedDate).toBe('None');
  });

  it('checks the next service when the best one fails, and fails only if all do', async () => {
    const http = world(items, { services: (u) => (u.includes('/Zoning/MapServer') ? reply({ error: { code: 499, message: 'Token Required' } }) : undefined) });
    const res = await checkMap(row(appUrl), deps(http));
    expect(res.status).toBe('OK');
    expect(res.normalizedUrl).not.toContain('/Zoning/MapServer');

    const allBad = world(items, { services: () => reply({ error: { code: 499, message: 'Token Required' } }) });
    expect((await checkMap(row(appUrl), deps(allBad))).status).toBe('TOKEN_REQUIRED');
  });

  it('respects the cap on services checked per viewer', async () => {
    const http = world(items, { serviceDate: null });
    const res = await checkMap(row(appUrl), deps(http, { maxResolvedServices: 2 }));
    expect(new Set(http.calls.filter((u) => /\/MapServer\?f=json$/.test(u)).map((u) => new URL(u).pathname)).size).toBe(2);
    expect(res.status).toBe('OK');
  });

  it('Experience Builder: follows the layer services, not every item id', async () => {
    const http = world({ [EXP.item.id]: EXP });
    const res = await checkMap(row('https://experience.arcgis.com/experience/e827d330f20a4508aa6777bf2c0b94e3'), deps(http));
    expect(res.status).toBe('OK');
    expect(res.serviceType).toMatch(/^App → /);
    const portalCalls = http.calls.filter((u) => u.includes('/sharing/rest/content/items/'));
    expect(portalCalls).toHaveLength(2); // the experience item and its data, nothing else
  });

  it('Dashboard: only an item id, so it follows that id to the web map', async () => {
    const items2: Record<string, Pair> = { [DASH.item.id]: DASH, df0449da5d83499a8c0a6528325be2f4: WEBMAP };
    const res = await checkMap(row('https://www.arcgis.com/apps/dashboards/5c6ba4921438443babc66c49e0088e35'), deps(world(items2)));
    expect(res.status).toBe('OK');
    expect(res.resolvedFrom).toContain('Dashboard');
    expect(res.resolvedFrom).toContain('Web Map');
  });

  it('Hub dataset links use the layer index after the item id', async () => {
    const svcItem = { id: 'c'.repeat(32), type: 'Feature Service', title: 'Zoning', url: 'https://services1.arcgis.com/ORG/arcgis/rest/services/Zoning/FeatureServer', modified: Date.UTC(2024, 0, 1) };
    const http = world({ [svcItem.id]: { item: svcItem, data: null } });
    const res = await checkMap(row(`https://city-hub.opendata.arcgis.com/datasets/${svcItem.id}_2/explore`), deps(http));
    expect(res.status).toBe('OK');
    expect(res.normalizedUrl).toBe('https://services1.arcgis.com/ORG/arcgis/rest/services/Zoning/FeatureServer/2');
  });

  it('enterprise portal: asks the web adaptor first', async () => {
    const http = world(items, { portalHost: /urbanail/ });
    await checkMap(row('https://maps.urbanail.gov/portalwebadaptor/apps/instant/lookup/index.html?appid=aa18a2d8737c4d66bb6434a09e17203a'), deps(http));
    expect(http.calls[0]).toBe('https://maps.urbanail.gov/portalwebadaptor/sharing/rest/content/items/aa18a2d8737c4d66bb6434a09e17203a?f=json');
  });
});

describe('when a viewer cannot be resolved', () => {
  const appUrl = 'https://city.maps.arcgis.com/apps/webappviewer/index.html?id=0123456789abcdef0123456789abcdef';

  it('item not found anywhere -> APP_URL_UNRESOLVED with the item id', async () => {
    const res = await checkMap(row(appUrl), deps(world({})));
    expect(res.status).toBe('APP_URL_UNRESOLVED');
    expect(res.issueReason).toContain('0123456789abcdef0123456789abcdef');
  });

  it('a private item is reported as private, not as "unresolved"', async () => {
    const http = new MockHttp([[/./, () => reply({ error: { code: 403, message: 'You do not have permissions to access this resource or perform this operation.' } })]]);
    expect((await checkMap(row(appUrl), deps(http))).status).toBe('HTTP_401_403');
    const tok = new MockHttp([[/./, () => reply({ error: { code: 499, message: 'Token Required' } })]]);
    expect((await checkMap(row(appUrl), deps(tok))).status).toBe('TOKEN_REQUIRED');
  });

  it('an app with no map service in it -> APP_URL_UNRESOLVED naming what was found', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    const http = world({ [id]: { item: { id, type: 'Web Mapping Application', title: 'City Portal', modified: 1 }, data: { values: { title: 'x' } } } });
    const res = await checkMap(row(appUrl), deps(http));
    expect(res.status).toBe('APP_URL_UNRESOLVED');
    expect(res.issueReason).toContain('Web Mapping Application "City Portal"');
  });

  it('a link with no item id at all is unresolved without a request', async () => {
    const http = world({});
    const res = await checkMap(row('https://experience.arcgis.com/'), deps(http));
    expect(res.status).toBe('APP_URL_UNRESOLVED');
    expect(http.calls).toHaveLength(0);
  });

  it('a dead portal host is reported as the connection failure it is', async () => {
    const http = new MockHttp([[/./, () => new HttpError('TIMEOUT', 'x')]]);
    expect((await checkMap(row('https://maps.example.gov/portalwebadaptor/apps/instant/index.html?appid=0123456789abcdef0123456789abcdef'), deps(http, { retries: { max: 0, baseDelayMs: 1, maxDelayMs: 1 } }))).status).toBe('TIMEOUT');
  });

  it('loops and huge apps are bounded: at most 8 portal items are read', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, '0'));
    const items: Record<string, Pair> = {};
    ids.forEach((id, i) => (items[id] = { item: { id, type: 'Dashboard', title: `D${i}`, modified: 1 }, data: { elements: [{ itemId: ids[(i + 1) % 20] }, { itemId: ids[(i + 2) % 20] }] } }));
    const http = world(items);
    const res = await checkMap(row(`https://www.arcgis.com/apps/dashboards/${ids[0]}`), deps(http));
    expect(res.status).toBe('APP_URL_UNRESOLVED');
    expect(http.calls.filter((u) => /\/items\/[0-9a-f]{32}\?f=json$/.test(u)).length).toBeLessThanOrEqual(8 * 4);
  });
});

describe('url recognition', () => {
  it('keeps the hub layer index', () => {
    const n = normalizeUrl('https://city-hub.opendata.arcgis.com/datasets/' + 'd'.repeat(32) + '_3/explore');
    expect(n).toMatchObject({ ok: true, kind: 'AppUrl', hubLayer: 3 });
  });
});

describe('shapes found in a real analyst sheet', () => {
  const EMB = { item: P('webmap_embedded.item'), data: P('webmap_embedded.data') };
  const MORRIS = P('service_item_morris.item');

  it('a web map that stores its data inside itself has no service: its own modified date is the answer, labelled low confidence', async () => {
    const r = extractRefs(EMB.item, EMB.data);
    expect(r.services).toEqual([]);
    expect(r.embedded).toBeGreaterThan(0);
    const http = world({ [EMB.item.id]: EMB });
    const res = await checkMap(row(`https://www.arcgis.com/home/webmap/viewer.html?webmap=${EMB.item.id}&extent=-111.9,42.0,-111.7,42.1`), deps(http));
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe(new Date(EMB.item.modified).toISOString().slice(0, 10));
    expect(res.dateSource).toBe('Portal:item.modified');
    expect(res.dateConfidence).toBe('low');
    expect(res.resolvedFrom).toContain('stored inside the web map');
    expect(res.layersChecked).toBe(0);
  });

  it('Map Viewer links with layers=<item id> resolve through the service item', async () => {
    const url = `https://www.arcgis.com/apps/mapviewer/index.html?layers=${MORRIS.id}`;
    expect(normalizeUrl(url)).toMatchObject({ ok: true, kind: 'AppUrl', itemId: MORRIS.id });
    const http = world({ [MORRIS.id]: { item: MORRIS, data: null } });
    const res = await checkMap(row(url), deps(http));
    expect(res.status).toBe('OK');
    expect(res.normalizedUrl).toBe('https://gis.njtpa.org/server/rest/services/LandUse/NJTPA_Zoning/FeatureServer/4');
    expect(res.itemModifiedDate).toBe('2025-02-27');
  });

  it('a Hub link that names the dataset instead of giving an id says exactly what to paste, without a request', async () => {
    const url = 'https://hub.arcgis.com/datasets/NJTPA::monmouth-county-zoning/explore?location=40.4%2C-74.2%2C18';
    expect(normalizeUrl(url)).toMatchObject({ ok: true, kind: 'AppUrl', hubSlug: 'NJTPA::monmouth-county-zoning' });
    const http = world({});
    const res = await checkMap(row(url), deps(http));
    expect(res.status).toBe('APP_URL_UNRESOLVED');
    expect(res.issueReason).toContain('NJTPA::monmouth-county-zoning');
    expect(res.issueReason).toContain('View API Resources');
    expect(http.calls).toHaveLength(0);
  });
});
