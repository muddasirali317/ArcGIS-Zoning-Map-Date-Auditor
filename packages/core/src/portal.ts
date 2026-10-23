/**
 * Resolving ArcGIS Online / Enterprise viewer links to the map services behind them (PRD 5.1).
 * Pure helpers only; the engine does the requests.
 *
 * Shapes seen in real items (saved under tests/fixtures/real/portal):
 *  - Web Map: data.operationalLayers[].url
 *  - Configurable / Instant app: data.values.webmap = <web map item id>
 *  - Experience Builder: many service URLs and itemIds scattered through a large data JSON
 *  - Dashboard: only an itemId (a web map)
 *  - Feature/Map Service item: item.url is the service
 */

export interface ServiceRef {
  url: string;
  title: string;
  /** Item the reference was found in. */
  from: string;
}

export interface ChildItem {
  id: string;
  /** Strong ids are known web maps: always followed. Weak ids (plain `itemId`) only when no service was found yet. */
  strong: boolean;
}

const SERVICE_URL = /^https?:\/\/[^\s"']+?\/(?:MapServer|FeatureServer|ImageServer)(?:\/\d+)?\/?$/i;
const STRONG_KEYS = /^(webmap|webmapid|webmapitemid|mapitemid)$/i;
const HEX32 = /^[0-9a-f]{32}$/i;

/** Background / utility services that are never the zoning map. */
const BASEMAP_HOSTS = /(^|\.)(services|server)\.arcgisonline\.com$|(^|\.)tiles\.arcgis\.com$|(^|\.)basemaps\.arcgis\.com$|(^|\.)ibasemaps-api\.arcgis\.com$|(^|\.)vectortileservices\d*\.arcgis\.com$/i;

export const SERVICE_ITEM_TYPES = new Set(['Feature Service', 'Map Service', 'Image Service']);

export function isBasemapUrl(url: string): boolean {
  try {
    return BASEMAP_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Candidate portal roots to ask for `sharing/rest/content/items/{id}`, most likely first. */
export function portalBases(appUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(appUrl);
  } catch {
    return ['https://www.arcgis.com'];
  }
  const out: string[] = [];
  const add = (b: string) => out.includes(b) || out.push(b);
  const host = u.hostname.toLowerCase();
  if (host.endsWith('arcgis.com')) {
    // Organisation sites (city.maps.arcgis.com) first; public items are also served from www.arcgis.com.
    if (/\.maps\.arcgis\.com$/.test(host)) add(u.origin);
    add('https://www.arcgis.com');
    return out;
  }
  // Enterprise portal behind a web adaptor: https://gis.city.gov/portalwebadaptor/apps/instant/...
  const first = u.pathname.split('/').filter(Boolean)[0];
  if (first && !/^(apps|home|sharing|rest|arcgis|experience|datasets)$/i.test(first)) add(`${u.origin}/${first}`);
  add(`${u.origin}/portal`);
  add(u.origin);
  add('https://www.arcgis.com');
  return out.slice(0, 4);
}

export const itemUrl = (base: string, id: string) => `${base}/sharing/rest/content/items/${id}?f=json`;
export const itemDataUrl = (base: string, id: string) => `${base}/sharing/rest/content/items/${id}/data?f=json`;

const titleOf = (o: any): string => String(o?.title ?? o?.name ?? o?.label ?? '');

/** Service URLs and child item ids found in an item (and its data JSON). */
export function extractRefs(item: any, data: any): { services: ServiceRef[]; children: ChildItem[]; embedded: number } {
  const from = String(item?.id ?? '');
  /** Layers whose data is stored inside the web map itself (feature collections): there is no service to ask. */
  let embedded = 0;
  const services: ServiceRef[] = [];
  const children = new Map<string, boolean>();
  const seen = new Set<string>();

  const addService = (url: string, title: string) => {
    const clean = url.split('?')[0].replace(/\/+$/, '');
    if (!SERVICE_URL.test(clean) || isBasemapUrl(clean) || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    services.push({ url: clean, title, from });
  };
  const addChild = (id: string, strong: boolean) => {
    if (!HEX32.test(id) || id.toLowerCase() === from.toLowerCase()) return;
    const key = id.toLowerCase();
    children.set(key, (children.get(key) ?? false) || strong);
  };

  if (item && SERVICE_ITEM_TYPES.has(item.type) && typeof item.url === 'string') addService(item.url, String(item.title ?? ''));

  const walk = (node: unknown, parentTitle: string, depth: number) => {
    if (depth > 14 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, parentTitle, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const title = titleOf(obj) || parentTitle;
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'baseMap') continue; // base map layers are background imagery, never the zoning map
      if (key === 'featureCollection' && value && typeof value === 'object') {
        embedded++;
        continue;
      }
      if (typeof value === 'string') {
        if (/^https?:\/\//i.test(value)) addService(value, title);
        else if (STRONG_KEYS.test(key)) addChild(value, true);
        else if (key === 'itemId') addChild(value, false);
      } else walk(value, title, depth + 1);
    }
  };
  walk(data, '', 0);
  return { services, children: [...children].map(([id, strong]) => ({ id, strong })), embedded };
}
