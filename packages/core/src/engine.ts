/**
 * Endpoint checking engine (PRD section 5), Phase 1: service root, per-layer metadata,
 * and attribute statistics. Portal items, legends and app URLs come in later phases.
 */
import type { Config } from './config';
import { normalizeName } from './config';
import { earliest, fromEpochMs, isFuture, latest, localDate, parseDateStrings } from './dates';
import type { HostBreaker } from './breaker';
import { AbortedError, HttpError, type HttpClient, type HttpResponse } from './http';
import { TOOL_VERSION } from './issues';
import { extractRefs, itemDataUrl, itemUrl, portalBases, SERVICE_ITEM_TYPES, type ChildItem, type ServiceRef } from './portal';
import type {
  CheckResult,
  CheckRow,
  Confidence,
  DateEvidence,
  DateKind,
  FailureCode,
  IssueCode,
  IssueNote,
  LayerDetail,
} from './types';
import { jsonUrl, normalizeUrl, type NormalizedUrl } from './url';

export interface EngineDeps {
  http: HttpClient;
  config: Config;
  now?: () => Date;
  /** Injectable for tests. Must reject with AbortedError when the signal fires. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  via?: 'server' | 'browser';
  /** Shared across one run so a dead host is skipped after repeated connection failures. */
  breaker?: HostBreaker;
}

class Failure extends Error {
  constructor(
    public code: FailureCode,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'Failure';
  }
}

interface Ctx {
  deps: EngineDeps;
  now: Date;
  retries: number;
  ms: number;
  lastUrl: string;
  warnings: IssueNote[];
  dates: DateEvidence[];
}

const CONNECTION_LEVEL = new Set(['TIMEOUT', 'DNS_FAIL', 'SSL_ERROR', 'CONNECTION_FAILED']);
const RETRYABLE = new Set<FailureCode>(['TIMEOUT', 'HTTP_429', 'HTTP_5XX', 'CONNECTION_FAILED']);
const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function parseRetryAfter(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const when = Date.parse(v);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

function arcgisError(err: any, status: number): Failure {
  const code = Number(err?.code);
  const msg = [err?.message, ...(Array.isArray(err?.details) ? err.details : [])].filter(Boolean).join(' ').trim();
  if (code === 498 || code === 499) {
    return new Failure('TOKEN_REQUIRED', `Server returned a login-required error (code ${code}). This service is private.`);
  }
  if (code === 400 && /invalid url/i.test(msg)) {
    return new Failure('URL_MALFORMED', 'ArcGIS says the URL is invalid. Check the path in the sheet, for example a missing "/" before "arcgis" or "rest".');
  }
  if (/stopped|not started|not running/i.test(msg)) {
    return new Failure('SERVICE_STOPPED', `The service exists but is not running${msg ? ` ("${msg}")` : ''}.`);
  }
  if (code === 401 || code === 403 || status === 401 || status === 403) {
    // Keep the server's own wording (e.g. "Administrative approval required") so the exact on-screen message reaches the report.
    return new Failure('HTTP_401_403', `Access denied (${code || status})${msg ? `: ${msg}` : ''}. The service is secured, or the server blocks this location.`);
  }
  if (code === 404 || status === 404) return new Failure('HTTP_404', `Not found (404)${msg ? `: ${msg}` : ''}. The service was moved or deleted.`);
  if (code === 410 || status === 410) return new Failure('HTTP_410', `Gone (410)${msg ? `: ${msg}` : ''}. The service was removed.`);
  if (code === 429 || status === 429) return new Failure('HTTP_429', `The server is rate limiting requests (429)${msg ? `: ${msg}` : ''}.`);
  if (code >= 500 || status >= 500) return new Failure('HTTP_5XX', `Server error (${code || status})${msg ? `: ${msg}` : ''}.`);
  return new Failure('ARCGIS_ERROR', `ArcGIS returned an error${code ? ` (${code})` : ''}${msg ? `: ${msg}` : ''}.`);
}

/** Turn an HTTP response into parsed ArcGIS JSON, or throw a classified Failure. */
function interpret(res: HttpResponse): any {
  const s = res.status;
  const text = res.body.trim();
  let json: any;
  let parsed = false;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      json = JSON.parse(text);
      parsed = true;
    } catch {
      /* fall through: treated as non-JSON */
    }
  }
  // ArcGIS reports errors as JSON, frequently with HTTP 200 (498/499 token errors especially).
  if (parsed && json && typeof json === 'object' && json.error) throw arcgisError(json.error, s);

  const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
  if (s === 404) throw new Failure('HTTP_404', 'Not found (404). The service was moved or deleted.');
  if (s === 410) throw new Failure('HTTP_410', 'Gone (410). The service was removed.');
  if (s === 401 || s === 403) throw new Failure('HTTP_401_403', `Access denied (${s}). The service is secured, or the server blocks this location.`);
  if (s === 429) throw new Failure('HTTP_429', 'The server is rate limiting requests (429).', retryAfterMs);
  if (s >= 500) throw new Failure('HTTP_5XX', `Server error (${s}).`, retryAfterMs);
  if (s < 200 || s >= 300) throw new Failure('NOT_ARCGIS', `The server answered HTTP ${s}, not ArcGIS data.`);
  if (!parsed) {
    const html = /html/i.test(res.headers['content-type'] ?? '') || /^<(!doctype|html)/i.test(text);
    throw new Failure('NOT_ARCGIS', html ? 'The server returned a web page, not ArcGIS data. Find the REST endpoint (…/MapServer or …/FeatureServer).' : 'The server did not return JSON, so this is not an ArcGIS REST endpoint.');
  }
  return json;
}

function fromHttpError(e: HttpError, url: string, ctx: Ctx): Failure {
  const host = safeHost(url);
  switch (e.code) {
    case 'TIMEOUT':
      {
        const message = e.message.trim();
        const connectTimeout = /connect.*timeout|timeout.*connect|UND_ERR_CONNECT_TIMEOUT/i.test(message);
        const responseTimeout = /headers?.*timeout|body.*timeout|response.*timeout|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(message);
        const cause = message ? ` Transport detail: ${message}.` : '';
        const attempts = ctx.deps.config.retries.max + 1;
        if (connectTimeout) {
          // The TCP handshake never completed within the connect window, even after retrying: the server did not
          // accept a connection from here. If it opens in a browser, that network can reach it but this one cannot.
          return new Failure(
            'TIMEOUT',
            `The server did not accept a connection within ${ctx.deps.config.timeouts.connectMs} ms at ${host}, across ${attempts} attempt${attempts === 1 ? '' : 's'}. The map's data was never reached, so no date could be read. This usually means the server blocks traffic from this machine's network — many US city GIS servers block non-US or datacentre addresses — or the server is down. If the link opens in your browser, turn the VPN on in the browser and use "Re-check failed in browser", or set UPSTREAM_PROXY so the server itself uses the VPN/proxy. Failed request: ${url}.${cause}`,
          );
        }
        const limit = responseTimeout
          ? `The server connected but did not finish responding within ${ctx.deps.config.timeouts.totalMs} ms`
          : `The request exceeded its ${ctx.deps.config.timeouts.totalMs} ms total timeout (connect limit ${ctx.deps.config.timeouts.connectMs} ms)`;
        return new Failure(
          'TIMEOUT',
          `${limit}. Failed request: ${url}. The checker tried ${attempts} time${attempts === 1 ? '' : 's'}; the server connected but was too slow — a slow or overloaded GIS server, or a heavy ArcGIS query.${cause}`,
        );
      }
    case 'DNS_FAIL':
      return new Failure('DNS_FAIL', `The domain ${host} does not resolve. It may no longer exist.`);
    case 'SSL_ERROR':
      return new Failure('SSL_ERROR', `The server's security certificate is invalid or expired (${e.message}).`);
    case 'REDIRECT_LOOP':
      return new Failure('REDIRECT_LOOP', 'The server redirected too many times.');
    case 'CORS_BLOCKED':
      return new Failure('CORS_BLOCKED', 'The browser could not read the server\'s answer (blocked by CORS, or the connection failed).');
    case 'TOO_LARGE':
      return new Failure('NOT_ARCGIS', `The response was larger than the ${Math.round(ctx.deps.config.maxResponseBytes / 1048576)} MB limit, so it is unlikely to be a service description.`);
    case 'BLOCKED_HOST':
      return new Failure('URL_MALFORMED', `${host} is a private or local address, which this tool refuses to contact.`);
    default:
      return new Failure('CONNECTION_FAILED', `The connection was refused or reset${e.message ? ` (${e.message})` : ''}. The server may be down, or it may block traffic from outside the US.`);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function requestJson(ctx: Ctx, url: string): Promise<any> {
  const { http, config, signal } = ctx.deps;
  const sleep = ctx.deps.sleep ?? defaultSleep;
  ctx.lastUrl = url;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    const hostKey = safeHost(url);
    const breaker = ctx.deps.breaker;
    if (breaker?.isOpen(hostKey)) throw new Failure('HOST_UNREACHABLE', breaker.describe(hostKey));
    let failure: Failure;
    const started = performance.now();
    try {
      const res = await http.get(url, { signal });
      ctx.ms += res.ms;
      breaker?.recordSuccess(hostKey); // any HTTP answer proves the host is reachable
      return interpret(res);
    } catch (e) {
      if (!(e instanceof Failure)) ctx.ms += performance.now() - started; // time spent on requests that failed outright
      if (signal?.aborted || e instanceof AbortedError) throw new AbortedError();
      if (e instanceof Failure) failure = e;
      else if (e instanceof HttpError) {
        failure = fromHttpError(e, url, ctx);
        if (CONNECTION_LEVEL.has(failure.code)) breaker?.recordFailure(hostKey, failure.code);
      } else throw e;
    }
    if (!RETRYABLE.has(failure.code) || attempt >= config.retries.max) throw failure;
    ctx.retries++;
    const { baseDelayMs, maxDelayMs } = config.retries;
    const backoff = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
    await sleep(Math.min(maxDelayMs, Math.max(backoff, failure.retryAfterMs ?? 0)), signal);
  }
}

// ---------------------------------------------------------------------------
// Date evidence
// ---------------------------------------------------------------------------

const CONFIDENCE: Record<DateKind, Confidence> = { attribute: 'high', editingInfo: 'high', serviceProperty: 'medium', portalItem: 'low' };

function warn(ctx: Ctx, code: IssueNote['code'], reason: string) {
  if (!ctx.warnings.some((w) => w.code === code && w.reason === reason)) ctx.warnings.push({ code, reason });
}

function addEvidence(
  ctx: Ctx,
  e: Omit<DateEvidence, 'confidence' | 'future'> & { date: string },
): DateEvidence {
  const ev: DateEvidence = { ...e, confidence: CONFIDENCE[e.kind], future: isFuture(e.date, ctx.now) };
  ctx.dates.push(ev);
  if (ev.future) warn(ctx, 'DATE_IN_FUTURE', `A date in the future (${ev.date}) was found in ${ev.source}. It may be a genuine effective date.`);
  return ev;
}

/** Epoch number or text date found in JSON metadata (not a queried attribute). */
function addJsonValue(ctx: Ctx, value: unknown, base: Pick<DateEvidence, 'kind' | 'source' | 'evidenceUrl'> & Partial<DateEvidence>, eligible = true) {
  const sentinels = ctx.deps.config.sentinels;
  if (typeof value === 'number') {
    const r = fromEpochMs(value, sentinels);
    if (r.kind === 'sentinel') return warn(ctx, 'DATE_SENTINEL_IGNORED', `${base.source} holds a placeholder date (${r.reason}); it was ignored.`);
    addEvidence(ctx, { ...base, date: r.date, iso: r.iso, role: 'value', primaryEligible: eligible });
  } else if (typeof value === 'string' && value.trim()) {
    const p = parseDateStrings([value], sentinels);
    if (p.sentinels.length) warn(ctx, 'DATE_SENTINEL_IGNORED', `${base.source} holds a placeholder date ("${value}"); it was ignored.`);
    if (p.ambiguous.length) warn(ctx, 'AMBIGUOUS_FORMAT', `${base.source} holds "${value}", where day and month cannot be told apart; it was not used.`);
    const v = p.valid[0];
    if (v) addEvidence(ctx, { ...base, date: v.date, iso: v.iso, role: 'value', primaryEligible: eligible });
  }
}

const EDITING_KEYS: [string, boolean][] = [
  ['dataLastEditDate', true],
  ['lastEditDate', true],
  ['schemaLastEditDate', false], // schema changes are not data changes
];

function collectEditingInfo(ctx: Ctx, info: any, source: string, evidenceUrl: string, layer?: { id: number; name: string }) {
  if (!info || typeof info !== 'object') return;
  for (const [key, eligible] of EDITING_KEYS) {
    if (info[key] === undefined || info[key] === null) continue;
    addJsonValue(
      ctx,
      info[key],
      { kind: 'editingInfo', source: key === 'dataLastEditDate' || key === 'lastEditDate' ? source : `${source}.${key}`, field: key, evidenceUrl, layer: layer?.name, layerId: layer?.id },
      eligible,
    );
  }
}

const WALK_SKIP = new Set(['layers', 'tables', 'fields', 'drawingInfo', 'extent', 'fullExtent', 'initialExtent', 'spatialReference', 'editingInfo', 'relationships', 'types', 'templates', 'indexes', 'subLayers', 'tileInfo', 'advancedQueryCapabilities', 'editFieldsInfo']);

/** Properties anywhere in the JSON (not in fields[]) whose name is on the date-field list. */
function collectServiceProps(ctx: Ctx, obj: any, prefix: 'Service' | 'Layer', evidenceUrl: string, layer?: { id: number; name: string }, path: string[] = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || path.length > 3) return;
  for (const [key, value] of Object.entries(obj)) {
    if (WALK_SKIP.has(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectServiceProps(ctx, value, prefix, evidenceUrl, layer, [...path, key]);
    } else if (ctx.deps.config.dateFields.has(normalizeName(key))) {
      const full = [...path, key].join('.');
      addJsonValue(ctx, value, { kind: 'serviceProperty', source: `${prefix}:${full}`, field: full, evidenceUrl, layer: layer?.name, layerId: layer?.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Higher = more zoning-like. Keywords earlier in the config list weigh more. */
export function zoningScore(name: string, keywords: string[]): number {
  const n = name.toLowerCase();
  const compact = n.replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < keywords.length; i++) {
    const k = keywords[i].toLowerCase();
    if (n.includes(k) || compact.includes(k.replace(/[^a-z0-9]/g, ''))) return keywords.length - i;
  }
  return 0;
}

const getCI = (obj: Record<string, unknown> | undefined, key: string): unknown => {
  if (!obj) return undefined;
  if (key in obj) return obj[key];
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? obj[k] : undefined;
};

const QUERYABLE_TYPES = new Set(['feature layer', 'table', 'oriented imagery layer']);
const TEXT_TYPES = new Set(['esriFieldTypeString', 'esriFieldTypeInteger', 'esriFieldTypeSmallInteger', 'esriFieldTypeBigInteger', 'esriFieldTypeDouble']);

async function queryDateField(ctx: Ctx, layerUrl: string, layer: LayerDetail, L: any, field: string, textLike: boolean) {
  const sentinels = ctx.deps.config.sentinels;
  const where = enc(`${field} IS NOT NULL`);
  const label = `${layer.name}.${field}`;
  const src = `Attribute:${field}`;
  const push = (role: 'max' | 'min', date: string, iso: string, evidenceUrl: string) =>
    addEvidence(ctx, { date, iso, kind: 'attribute', source: src, field, layer: layer.name, layerId: layer.id, role, primaryEligible: role === 'max', evidenceUrl });

  if (textLike) {
    const url = `${layerUrl}/query?where=${where}&outFields=${enc(field)}&returnDistinctValues=true&returnGeometry=false&f=json`;
    const json = await requestJson(ctx, url);
    const values = (json.features ?? []).map((f: any) => getCI(f?.attributes, field)).filter((v: unknown) => v !== null && v !== undefined && v !== '').map(String);
    layer.nonNullCounts[field] = values.length;
    const p = parseDateStrings(values, sentinels);
    if (p.sentinels.length) warn(ctx, 'DATE_SENTINEL_IGNORED', `${label} holds placeholder dates ("${p.sentinels[0]}"); they were ignored.`);
    if (p.ambiguous.length) warn(ctx, 'AMBIGUOUS_FORMAT', `${label} has text dates whose day and month cannot be told apart (e.g. "${p.ambiguous[0]}"); those values were not used.`);
    if (p.unparsed.length && p.valid.length === 0) warn(ctx, 'AMBIGUOUS_FORMAT', `${label} holds text that could not be read as a date (e.g. "${p.unparsed[0]}").`);
    if (json.exceededTransferLimit) warn(ctx, 'AMBIGUOUS_FORMAT', `${label} is a text field with more distinct values than the server returns at once, so its latest date may be missed.`);
    const max = latest(p);
    const min = earliest(p);
    if (max) push('max', max.date, max.iso, url);
    if (min && min.date !== max?.date) push('min', min.date, min.iso, url);
    return;
  }

  const supportsStats = L.advancedQueryCapabilities?.supportsStatistics !== false && L.supportsStatistics !== false;
  let max: unknown;
  let min: unknown;
  let count: unknown;
  let evidenceUrl = '';
  let gotStats = false;

  if (supportsStats) {
    const stats = [
      { statisticType: 'max', onStatisticField: field, outStatisticFieldName: 'max_d' },
      { statisticType: 'min', onStatisticField: field, outStatisticFieldName: 'min_d' },
      { statisticType: 'count', onStatisticField: field, outStatisticFieldName: 'nn_count' },
    ];
    evidenceUrl = `${layerUrl}/query?where=${enc('1=1')}&outStatistics=${enc(JSON.stringify(stats))}&f=json`;
    try {
      const json = await requestJson(ctx, evidenceUrl);
      const attrs = json.features?.[0]?.attributes;
      if (attrs) {
        gotStats = true;
        max = getCI(attrs, 'max_d');
        min = getCI(attrs, 'min_d');
        count = getCI(attrs, 'nn_count');
      }
    } catch (e) {
      if (!(e instanceof Failure) || !['ARCGIS_ERROR', 'HTTP_5XX', 'NOT_ARCGIS'].includes(e.code)) throw e;
    }
  }

  if (!gotStats) {
    // Statistics unsupported or refused: ask for the single newest (and oldest) row instead.
    const top = async (dir: 'DESC' | 'ASC') => {
      const url = `${layerUrl}/query?where=${where}&outFields=${enc(field)}&orderByFields=${enc(`${field} ${dir}`)}&resultRecordCount=1&returnGeometry=false&f=json`;
      const json = await requestJson(ctx, url);
      return { url, value: getCI(json.features?.[0]?.attributes, field) };
    };
    const hi = await top('DESC');
    evidenceUrl = hi.url;
    max = hi.value;
    min = (await top('ASC')).value;
  }

  if (typeof count === 'number') layer.nonNullCounts[field] = count;
  const handle = (value: unknown, role: 'max' | 'min') => {
    if (value === null || value === undefined) return;
    const r = fromEpochMs(Number(value), sentinels);
    if (r.kind === 'sentinel') return warn(ctx, 'DATE_SENTINEL_IGNORED', `${label} holds a placeholder ${role === 'max' ? 'latest' : 'earliest'} date (${r.reason}); it was ignored.`);
    push(role, r.date, r.iso, evidenceUrl);
  };
  handle(max, 'max');
  handle(min, 'min');
}

async function checkLayer(ctx: Ctx, serviceUrl: string, ref: { id: number; name: string }, score: number): Promise<LayerDetail> {
  const { config } = ctx.deps;
  const layerUrl = `${serviceUrl}/${ref.id}`;
  const layerJson = jsonUrl(layerUrl);
  const detail: LayerDetail = { id: ref.id, name: ref.name, zoningScore: score, matchedFields: [], otherDateFields: [], dates: [], nonNullCounts: {} };
  const before = ctx.dates.length;

  const L = await requestJson(ctx, layerJson);
  detail.name = L.name ?? ref.name;
  detail.type = L.type;
  detail.geometryType = L.geometryType;
  detail.maxRecordCount = L.maxRecordCount;
  const layerRef = { id: ref.id, name: detail.name };

  collectEditingInfo(ctx, L.editingInfo, 'Layer:editingInfo', layerJson, layerRef);
  collectServiceProps(ctx, L, 'Layer', layerJson, layerRef);

  const fields: any[] = Array.isArray(L.fields) ? L.fields : [];
  const trackerField: string | undefined = L.editFieldsInfo?.editDateField;
  const isMatch = (name: string) => config.dateFields.has(normalizeName(name)) || (!!trackerField && name.toLowerCase() === trackerField.toLowerCase());

  const matched = fields.filter((f) => isMatch(String(f.name)));
  detail.matchedFields = matched.map((f) => f.name);
  detail.otherDateFields = fields.filter((f) => f.type === 'esriFieldTypeDate' && !isMatch(String(f.name))).map((f) => f.name);

  const caps = typeof L.capabilities === 'string' ? L.capabilities : '';
  const canQuery = (!caps || /query/i.test(caps)) && (!L.type || QUERYABLE_TYPES.has(String(L.type).toLowerCase()));
  if (matched.length > 0 && !canQuery) {
    detail.note = 'Date fields exist but this layer does not allow queries, so their values could not be read.';
  } else {
    for (const f of matched) {
      if (f.type === 'esriFieldTypeDate' || TEXT_TYPES.has(f.type)) {
        try {
          await queryDateField(ctx, layerUrl, detail, L, f.name, f.type !== 'esriFieldTypeDate');
        } catch (e) {
          if (!(e instanceof Failure)) throw e;
          detail.error = `${f.name}: ${e.message}`;
          warn(ctx, e.code as IssueNote['code'], `Layer "${detail.name}": ${e.message}`);
        }
      } else {
        detail.note = `${f.name} has type ${f.type}, which this tool cannot read as a date.`;
      }
    }
  }

  detail.dates = ctx.dates.slice(before);
  return detail;
}

// ---------------------------------------------------------------------------
// Primary date
// ---------------------------------------------------------------------------

interface Picked {
  primary: DateEvidence | null;
  attrMax: DateEvidence | null;
  attrMin: DateEvidence | null;
  editing: DateEvidence | null;
}

/**
 * The newest attribute date. When some layers are zoning-like (zoningLayers), their attribute dates decide: an
 * unrelated layer that was edited more recently (parcels, addresses) must not stand in for the zoning map's date.
 * Other layers count only when no zoning layer has an attribute date.
 */
function pickAttribute(dates: DateEvidence[], zoningLayers?: Set<string>): DateEvidence | null {
  const all = dates.filter((d) => d.kind === 'attribute' && d.primaryEligible);
  const zoning = zoningLayers?.size ? all.filter((d) => d.layer !== undefined && zoningLayers.has(d.layer)) : [];
  const cands = zoning.length ? zoning : all;
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.date > a.date ? b : a));
}

/** The service's last edit date: the newest eligible editingInfo date (lastEditDate, or dataLastEditDate when that is all there is). */
function pickEditing(dates: DateEvidence[]): DateEvidence | null {
  const cands = dates.filter((d) => d.kind === 'editingInfo' && d.primaryEligible);
  // On a tie, name lastEditDate (the field the analyst works from) rather than dataLastEditDate.
  return cands.length ? cands.reduce((a, b) => (b.date > a.date || (b.date === a.date && b.field === 'lastEditDate') ? b : a)) : null;
}

function pickLatest(dates: DateEvidence[], kind: DateKind): DateEvidence | null {
  const cands = dates.filter((d) => d.kind === kind && d.primaryEligible);
  return cands.length ? cands.reduce((a, b) => (b.date > a.date ? b : a)) : null;
}

export function pickPrimary(dates: DateEvidence[], priority: DateKind[], mode: 'latest' | 'priority' = 'latest', zoningLayers?: Set<string>): Picked {
  const attrMax = pickAttribute(dates, zoningLayers);
  const attrMin = attrMax ? dates.find((d) => d.kind === 'attribute' && d.role === 'min' && d.layerId === attrMax.layerId && d.field === attrMax.field) ?? null : null;
  const editing = pickEditing(dates);
  const byKind: Record<DateKind, DateEvidence | null> = {
    attribute: attrMax,
    editingInfo: editing,
    serviceProperty: pickLatest(dates, 'serviceProperty'),
    portalItem: pickLatest(dates, 'portalItem'),
  };
  let primary: DateEvidence | null = null;
  if (mode === 'latest') {
    const rank: Record<DateKind, number> = { attribute: 3, editingInfo: 2, serviceProperty: 1, portalItem: 0 };
    const eligible = dates.filter((d) => d.primaryEligible && d.kind !== 'portalItem');
    primary = eligible.reduce<DateEvidence | null>((best, date) => (
      !best ||
      date.date > best.date ||
      (date.date === best.date &&
        (rank[date.kind] > rank[best.kind] ||
          (date.kind === 'editingInfo' && best.kind === 'editingInfo' && date.field === 'lastEditDate' && best.field !== 'lastEditDate')))
        ? date
        : best
    ), null) ?? byKind.portalItem;
    return { primary, attrMax, attrMin, editing };
  }
  for (const kind of priority) {
    if (byKind[kind]) {
      primary = byKind[kind];
      break;
    }
  }
  return { primary, attrMax, attrMin, editing };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function isArcgisShape(j: any): boolean {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
  return ['currentVersion', 'layers', 'serviceDescription', 'capabilities', 'mapName', 'fullExtent', 'pixelSizeX', 'services', 'folders', 'fields', 'type'].some((k) => k in j);
}

interface Analysis {
  serviceType: string;
  layers: LayerDetail[];
  rootUrl: string;
  /** For viewer links: the service URL that was actually checked. */
  resolvedUrl?: string;
  /** For viewer links: the chain of portal items followed, e.g. `Web Mapping Application "X" → Web Map "Y"`. */
  resolvedFrom?: string;
}

const CONNECTION_LEVEL_CODES = new Set<FailureCode>(['TIMEOUT', 'DNS_FAIL', 'SSL_ERROR', 'CONNECTION_FAILED', 'HOST_UNREACHABLE']);
const MAX_PORTAL_ITEMS = 8;
const MAX_PORTAL_DEPTH = 3;

/** Ask each candidate portal for an item. Item-not-found moves on to the next portal; a dead portal is reported as such. */
async function fetchPortalItem(ctx: Ctx, bases: string[], id: string): Promise<{ item: any; base: string }> {
  let connection: Failure | undefined;
  let other: Failure | undefined;
  for (const base of bases) {
    try {
      const item = await requestJson(ctx, itemUrl(base, id));
      if (item && typeof item === 'object' && item.id) return { item, base };
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      if (CONNECTION_LEVEL_CODES.has(e.code)) connection ??= e;
      else other = e;
    }
  }
  if (connection) throw connection;
  if (other && (other.code === 'TOKEN_REQUIRED' || other.code === 'HTTP_401_403')) throw other; // the item exists but is private
  throw new Failure('APP_URL_UNRESOLVED', `Could not find the viewer's item (${id}). It may be deleted, private, or on a different portal. Paste the REST link (…/MapServer or …/FeatureServer).`);
}

/**
 * Viewer / app link -> the map services behind it. Follows app -> web map -> layers (at most
 * MAX_PORTAL_ITEMS items, MAX_PORTAL_DEPTH levels), records the portal items' dates as low-confidence
 * evidence, then checks the best zoning-like services like any other map.
 */
async function analyseApp(ctx: Ctx, norm: Extract<NormalizedUrl, { ok: true }>): Promise<Analysis> {
  const { config } = ctx.deps;
  if (!norm.itemId) {
    if (norm.hubSlug) {
      throw new Failure('APP_URL_UNRESOLVED', `This is a Hub dataset link that names the dataset ("${norm.hubSlug}") instead of giving its item id, and Hub does not let the tool look that up. Open the dataset, copy the service URL from "I want to use this" → "View API Resources", and paste that.`);
    }
    throw new Failure('APP_URL_UNRESOLVED', 'This looks like a viewer link, but no item id could be found in it. Paste the REST link (…/MapServer or …/FeatureServer).');
  }

  const bases = portalBases(norm.serviceUrl);
  const queue: (ChildItem & { depth: number })[] = [{ id: norm.itemId, strong: true, depth: 0 }];
  const visited = new Set<string>();
  const services: ServiceRef[] = [];
  const trail: string[] = [];
  let embedded = 0;
  let goodBase: string | undefined;

  while (queue.length > 0 && visited.size < MAX_PORTAL_ITEMS) {
    const next = queue.shift()!;
    if (visited.has(next.id) || (!next.strong && services.length > 0)) continue;
    visited.add(next.id);
    const isRoot = next.depth === 0;
    let found;
    try {
      found = await fetchPortalItem(ctx, goodBase ? [goodBase, ...bases.filter((b) => b !== goodBase)] : bases, next.id);
    } catch (e) {
      if (isRoot || !(e instanceof Failure)) throw e;
      continue; // a child item we cannot read does not sink the map
    }
    const { item, base } = found;
    goodBase ??= base;
    trail.push(`${item.type} "${item.title ?? next.id}"`);

    let data: unknown = null;
    if (!SERVICE_ITEM_TYPES.has(item.type)) {
      try {
        data = await requestJson(ctx, itemDataUrl(base, next.id));
      } catch (e) {
        if (!(e instanceof Failure)) throw e; // no data for this item type: fine
      }
    }
    const refs = extractRefs(item, data);
    let direct = refs.services;
    if (norm.hubLayer !== undefined && SERVICE_ITEM_TYPES.has(item.type)) {
      direct = direct.map((s) => (/\/\d+$/.test(s.url) ? s : { ...s, url: `${s.url}/${norm.hubLayer}` }));
    }
    for (const s of direct) if (!services.some((x) => x.url.toLowerCase() === s.url.toLowerCase())) services.push(s);
    embedded += refs.embedded;

    // Item dates are low confidence (they change when only metadata is edited). Only items that hold the
    // layers themselves (web map, service item) can become the Primary Date; apps and dashboards are listed only.
    // A web map whose data is stored inside it has no other date: its modified date is the best there is.
    const evidenceUrl = itemUrl(base, next.id);
    const where = { kind: 'portalItem' as const, evidenceUrl, layer: String(item.title ?? '') };
    addJsonValue(ctx, item.modified, { ...where, source: 'Portal:item.modified', field: 'modified' }, direct.length > 0 || refs.embedded > 0);
    addJsonValue(ctx, item.created, { ...where, source: 'Portal:item.created', field: 'created' }, false);

    if (next.depth < MAX_PORTAL_DEPTH) for (const c of refs.children) queue.push({ ...c, depth: next.depth + 1 });
  }

  if (services.length === 0 && embedded > 0) {
    return {
      serviceType: 'App → web map (data stored inside the map)',
      layers: [],
      rootUrl: itemUrl(goodBase ?? bases[0], norm.itemId),
      resolvedFrom: `${trail.join(' → ')} (the map data is stored inside the web map, not in a service, so only the item's dates exist)`,
    };
  }
  if (services.length === 0) {
    throw new Failure('APP_URL_UNRESOLVED', `Found ${trail[0] ?? 'the viewer item'}, but it does not reference a map service the tool can read. Paste the REST link (…/MapServer or …/FeatureServer).`);
  }

  const ranked = services
    .map((s, i) => ({ s, i, score: zoningScore(`${s.title} ${s.url}`, config.layerKeywords) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, config.maxResolvedServices);

  const layers: LayerDetail[] = [];
  let first: { analysis: Analysis; url: string } | undefined;
  let lastFailure: Failure | undefined;
  for (const { s } of ranked) {
    const n = normalizeUrl(s.url);
    if (!n.ok || !['MapServer', 'FeatureServer', 'ImageServer'].includes(n.kind)) continue;
    try {
      const a = await analyse(ctx, n);
      first ??= { analysis: a, url: s.url };
      layers.push(...a.layers);
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      lastFailure = e;
      continue;
    }
  }
  if (!first) throw lastFailure ?? new Failure('APP_URL_UNRESOLVED', 'The viewer references no service the tool can check.');
  return {
    serviceType: `App → ${first.analysis.serviceType}`,
    layers,
    rootUrl: first.analysis.rootUrl,
    resolvedUrl: first.url,
    resolvedFrom: `${trail.join(' → ')} → ${first.url}`,
  };
}

async function analyse(ctx: Ctx, norm: Extract<NormalizedUrl, { ok: true }>): Promise<Analysis> {
  const { config } = ctx.deps;

  if (norm.kind === 'AppUrl') return analyseApp(ctx, norm);

  const rootUrl = jsonUrl(norm.serviceUrl);
  const root = await requestJson(ctx, rootUrl);
  if (!isArcgisShape(root)) throw new Failure('NOT_ARCGIS', 'The server returned JSON, but it does not look like an ArcGIS service.');

  if (norm.kind === 'Folder') {
    const names: string[] = [...(root.services ?? []).map((s: any) => `${s.name} (${s.type})`), ...(root.folders ?? []).map((f: string) => `${f}/`)];
    const shown = names.slice(0, 5).join(', ');
    throw new Failure('NO_LAYERS', `This link is a services folder, not one map. It lists ${names.length} item(s)${shown ? `: ${shown}${names.length > 5 ? ', …' : ''}` : ''}. Paste a single MapServer or FeatureServer link.`);
  }
  if (norm.kind === 'Unknown' && !('layers' in root || 'currentVersion' in root)) {
    throw new Failure('NOT_ARCGIS', 'The server returned JSON, but it does not look like an ArcGIS service.');
  }

  const serviceType = norm.kind === 'Unknown' ? 'Unknown' : norm.kind;
  collectEditingInfo(ctx, root.editingInfo, 'Service:editingInfo', rootUrl);
  collectServiceProps(ctx, root, 'Service', rootUrl);

  // Which layers to look at.
  let refs: { id: number; name: string }[];
  if (norm.layerId !== undefined) {
    refs = [{ id: norm.layerId, name: `Layer ${norm.layerId}` }];
  } else if (norm.kind === 'ImageServer') {
    refs = []; // metadata only (PRD 3)
  } else {
    const all: any[] = Array.isArray(root.layers) ? root.layers : [];
    refs = all.filter((l) => !(Array.isArray(l.subLayerIds) && l.subLayerIds.length > 0)).map((l) => ({ id: Number(l.id), name: String(l.name ?? `Layer ${l.id}`) }));
    if (refs.length === 0) throw new Failure('NO_LAYERS', 'The service has no layers.');
  }

  const ranked = refs
    .map((r, i) => ({ r, i, score: zoningScore(r.name, config.layerKeywords) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, config.maxLayersPerMap);

  const layers: LayerDetail[] = [];
  const layerFailures: Failure[] = [];
  for (const { r, score } of ranked) {
    try {
      const detail = await checkLayer(ctx, norm.serviceUrl, r, score);
      layers.push(detail);
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      if (norm.layerId !== undefined) throw e; // the one layer the analyst pointed at is the map
      layerFailures.push(e);
      layers.push({ id: r.id, name: r.name, zoningScore: score, matchedFields: [], otherDateFields: [], dates: [], nonNullCounts: {}, error: e.message });
    }
  }

  if (layerFailures.length > 0 && layerFailures.length === layers.length && ctx.dates.length === 0) throw layerFailures[0];
  if (layerFailures.length > 0) {
    const f = layerFailures[0];
    warn(ctx, f.code as IssueNote['code'], `${layerFailures.length} of ${layers.length} layer(s) could not be read. First error: ${f.message}`);
  }

  if (refs.length > ranked.length) {
    const skipped = refs.length - ranked.length;
    layers.forEach((l, i) => i === layers.length - 1 && (l.note = [l.note, `${skipped} lower-ranked layer(s) were not checked (limit ${config.maxLayersPerMap}).`].filter(Boolean).join(' ')));
  }
  return { serviceType, layers, rootUrl };
}

const dateOrNone = (e: DateEvidence | null) => (e ? e.date : 'None');

export async function checkMap(row: CheckRow, deps: EngineDeps): Promise<CheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const ctx: Ctx = { deps, now, retries: 0, ms: 0, lastUrl: '', warnings: [], dates: [] };
  const norm = normalizeUrl(row.url);

  let status: IssueCode = 'OK';
  let failure: Failure | null = null;
  let analysis: Analysis | null = null;

  if (!norm.ok) {
    failure = new Failure(norm.code, norm.reason);
  } else if (deps.breaker?.isOpen(norm.host)) {
    failure = new Failure('HOST_UNREACHABLE', deps.breaker.describe(norm.host));
  } else {
    try {
      analysis = await analyse(ctx, norm);
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      if (e instanceof Failure) failure = e;
      else failure = new Failure('ARCGIS_ERROR', `Unexpected error while checking this map: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const zoningLayers = new Set((analysis?.layers ?? []).filter((l) => l.zoningScore > 0).map((l) => l.name));
  const picked = pickPrimary(ctx.dates, deps.config.datePriority, deps.config.dateSelection, zoningLayers);
  const otherDateFields = unique((analysis?.layers ?? []).flatMap((l) => l.otherDateFields.map((f) => `${l.name}.${f}`)));
  const issues: IssueNote[] = [];

  if (failure) {
    status = failure.code;
    issues.push({ code: failure.code, reason: failure.message });
  } else if (!picked.primary) {
    status = 'OK_NO_DATE';
    const extra = otherDateFields.length ? ` Other date fields exist (${otherDateFields.slice(0, 4).join(', ')}${otherDateFields.length > 4 ? ', …' : ''}); see Other Date Fields Found.` : '';
    issues.push({ code: 'OK_NO_DATE', reason: `The map loaded, but no date was found in the service metadata or attributes.${extra}` });
  }
  issues.push(...ctx.warnings.filter((w) => !(failure && w.code === failure.code)));
  for (const pre of resultPreIssues(row)) if (!issues.some((i) => i.code === pre.code)) issues.push(pre);

  const p = picked.primary;
  const none = 'None';
  const zoningLayer =
    (p?.kind === 'attribute' ? p.layer : undefined) ??
    analysis?.layers.find((l) => l.zoningScore > 0)?.name ??
    '';

  return {
    id: row.id,
    sheetRow: row.sheetRow,
    city: row.city,
    state: row.state,
    county: row.county,
    sourceUrl: row.url,
    normalizedUrl: analysis?.resolvedUrl ?? (norm.ok ? `${norm.serviceUrl}${norm.layerId !== undefined ? `/${norm.layerId}` : ''}` : ''),
    resolvedFrom: analysis?.resolvedFrom,
    serviceType: norm.ok ? (analysis?.serviceType ?? norm.kind) : '',
    status,
    issues,
    issueReason: issues.map((i) => i.reason).join(' | '),
    primaryDate: dateOrNone(p),
    dateSource: p?.source ?? none,
    dateConfidence: p?.confidence ?? none,
    // A loaded map with no date is dated by its Review Date, so the field name says so instead of staying empty.
    dateFieldName: p?.field ?? (status === 'OK_NO_DATE' ? 'Review Date' : none),
    attributeMaxDate: dateOrNone(picked.attrMax),
    attributeMinDate: dateOrNone(picked.attrMin),
    serviceEditingInfoDate: dateOrNone(picked.editing),
    itemModifiedDate: dateOrNone(pickLatest(ctx.dates, 'portalItem')),
    allDates: ctx.dates,
    otherDateFields,
    zoningLayerName: zoningLayer,
    layersChecked: analysis?.layers.length ?? 0,
    layers: analysis?.layers ?? [],
    reviewDate: localDate(now),
    reviewedAt: now.toISOString(),
    reviewer: '',
    analystNote: '',
    evidenceUrl: p?.evidenceUrl ?? (analysis?.rootUrl ?? ctx.lastUrl),
    responseTimeMs: Math.round(ctx.ms),
    retries: ctx.retries,
    checkedAt: now.toISOString(),
    toolVersion: TOOL_VERSION,
    via: deps.via ?? 'server',
  };
}

function resultPreIssues(row: CheckRow): IssueNote[] {
  return row.preIssues;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Give a result computed for one row to another row with the same URL (a cache hit, or a duplicate
 * link in the same run): identity and the row's own duplicate flag change; the evidence does not.
 */
export function rebrandResult(r: CheckResult, row: CheckRow, now: Date, opts: { fromCache?: boolean; keepReview?: boolean } = {}): CheckResult {
  const issues = [...r.issues.filter((i) => i.code !== 'DUPLICATE_URL'), ...row.preIssues];
  const review = opts.keepReview
    ? {}
    : { reviewDate: localDate(now), reviewedAt: now.toISOString(), reviewer: '', analystNote: '', manualReview: false };
  return {
    ...r,
    id: row.id,
    sheetRow: row.sheetRow,
    city: row.city,
    state: row.state,
    county: row.county,
    sourceUrl: row.url,
    issues,
    issueReason: issues.map((i) => i.reason).join(' | '),
    ...review,
    fromCache: opts.fromCache ?? r.fromCache,
  };
}

/** Results worth keeping in the 24 h URL cache: the map loaded. Failures are usually temporary, so they are re-checked. */
export const isCacheable = (r: CheckResult) => r.status === 'OK' || r.status === 'OK_NO_DATE';
