/**
 * URL normalization (PRD 5.1). Phase 1 recognises service, layer and folder URLs.
 * Viewer / ArcGIS Online app URLs are detected (and their item id extracted) but
 * resolved to services only in Phase 3.
 */

export type ServiceKind = 'MapServer' | 'FeatureServer' | 'ImageServer' | 'Folder' | 'AppUrl' | 'Unknown';

export type NormalizedUrl =
  | {
      ok: true;
      kind: ServiceKind;
      host: string;
      /** URL to request with `f=json` (service root, folder, or the URL itself for Unknown). No query string. */
      serviceUrl: string;
      layerId?: number;
      itemId?: string;
      /** Hub dataset links end in _<layer index>: that layer of the item's service. */
      hubLayer?: number;
      /** Hub dataset links can name the dataset (`ORG::some-name`) instead of giving its item id. */
      hubSlug?: string;
      /** Case-insensitive key used for duplicate detection. */
      canonical: string;
    }
  | { ok: false; code: 'URL_EMPTY' | 'URL_MALFORMED'; reason: string };

const SERVICE_PATH = /^(.*?\/(MapServer|FeatureServer|ImageServer))(?:\/(\d+))?(?:\/.*)?$/i;
const FOLDER_PATH = /\/rest\/services(?:\/[^/]+)*\/?$/i;
const HEX32 = /[0-9a-f]{32}/i;

const APP_PATHS = /(\/apps\/|\/home\/item\.html|\/home\/webmap|\/webappviewer|\/instantapps|\/experience\/|\/storymaps|\/sharing\/rest\/content\/items\/|\/datasets\/)/i;
const APP_HOSTS = /(^|\.)(arcgis\.com|arcgis\.cn)$/i;

function cleanType(t: string): ServiceKind {
  const l = t.toLowerCase();
  if (l === 'mapserver') return 'MapServer';
  if (l === 'featureserver') return 'FeatureServer';
  return 'ImageServer';
}

export function normalizeUrl(input: string | undefined | null): NormalizedUrl {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, code: 'URL_EMPTY', reason: 'The Map URL cell is empty.' };

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // "gis.city.gov/arcgis/rest/services/..." pasted without a scheme.
    if (/^[^\s/]+\.[^\s/]+\/\S*$/.test(candidate) || /^[^\s/]+\.[a-z]{2,}$/i.test(candidate)) candidate = `https://${candidate}`;
    else return { ok: false, code: 'URL_MALFORMED', reason: `"${truncate(raw)}" is not a web address.` };
  }

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, code: 'URL_MALFORMED', reason: `"${truncate(raw)}" is not a valid web address.` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, code: 'URL_MALFORMED', reason: `Only http and https links can be checked (got ${u.protocol}).` };
  }
  const isBareName = !u.hostname.includes('.') && !u.hostname.startsWith('[') && u.hostname !== 'localhost';
  if (!u.hostname || isBareName) {
    return { ok: false, code: 'URL_MALFORMED', reason: `"${truncate(raw)}" has no usable host name.` };
  }

  const host = u.hostname.toLowerCase();
  const itemId = extractItemId(u);

  // Hash fragments, query strings and tokens are dropped: viewers put state there, and we never keep credentials.
  const path = u.pathname.replace(/\/+$/, '');
  const svc = SERVICE_PATH.exec(path);
  if (svc) {
    const serviceUrl = `${u.protocol}//${u.host}${svc[1]}`;
    const layerId = svc[3] !== undefined ? Number(svc[3]) : undefined;
    return {
      ok: true,
      kind: cleanType(svc[2]),
      host,
      serviceUrl,
      layerId,
      itemId,
      canonical: `${serviceUrl}${layerId !== undefined ? `/${layerId}` : ''}`.toLowerCase(),
    };
  }

  if (FOLDER_PATH.test(path)) {
    const serviceUrl = `${u.protocol}//${u.host}${path}`;
    return { ok: true, kind: 'Folder', host, serviceUrl, canonical: serviceUrl.toLowerCase() };
  }

  if ((APP_HOSTS.test(host) || /^(experience|hub)\./i.test(host)) && (APP_PATHS.test(path) || itemId || /^(experience|hub)\./i.test(host))) {
    return {
      ok: true,
      kind: 'AppUrl',
      host,
      serviceUrl: `${u.protocol}//${u.host}${path}`,
      itemId,
      hubLayer: hubLayerOf(path),
      hubSlug: itemId ? undefined : hubSlugOf(path),
      canonical: `${u.protocol}//${u.host}${path}${itemId ? `?id=${itemId}` : ''}`.toLowerCase(),
    };
  }
  if (/\/(webappviewer|apps\/)/i.test(path)) {
    return { ok: true, kind: 'AppUrl', host, serviceUrl: `${u.protocol}//${u.host}${path}`, itemId, canonical: `${u.protocol}//${u.host}${path}`.toLowerCase() };
  }

  // Not recognisable: the engine will request it once and classify what comes back (usually NOT_ARCGIS).
  const serviceUrl = `${u.protocol}//${u.host}${path}`;
  return { ok: true, kind: 'Unknown', host, serviceUrl, itemId, canonical: serviceUrl.toLowerCase() };
}

function hubLayerOf(path: string): number | undefined {
  const m = /\/datasets\/[0-9a-f]{32}_(\d+)/i.exec(path);
  return m ? Number(m[1]) : undefined;
}

function hubSlugOf(path: string): string | undefined {
  const m = /\/datasets\/([^/]+::[^/]+)/i.exec(path);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function extractItemId(u: URL): string | undefined {
  // `layers=<item id>` is what the Map Viewer uses when opened on one service (it may be a comma list).
  for (const key of ['id', 'appid', 'webmap', 'webmapId', 'itemId', 'layers']) {
    const v = u.searchParams.get(key);
    if (v && HEX32.test(v)) return HEX32.exec(v)![0].toLowerCase();
  }
  const m = HEX32.exec(u.pathname);
  return m ? m[0].toLowerCase() : undefined;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** URL used for the ArcGIS JSON request. */
export function jsonUrl(url: string): string {
  return `${url}?f=json`;
}
