/** PRD 12.2: classifier tests with mocked responses for each issue code. */
import { describe, expect, it } from 'vitest';
import { checkMap, HttpError, AbortedError, isFailure, isNetworkPathIssue, ISSUE_INFO, type CheckRow, type IssueCode } from '@zoning/core';
import { MockHttp, SVC, fixedNow, noSleep, rawConfig, reply, row, testConfig, zoningService } from './helpers';

const run = (http: MockHttp, url = SVC, r: Partial<CheckRow> = {}) => checkMap(row(url, r), { http, config: testConfig(), now: fixedNow, sleep: noSleep });
const always = (h: () => any) => new MockHttp([[/./, h]]);
const arcgisErr = (code: number, message = 'x', status = 200) => reply({ error: { code, message, details: [] } }, status);

describe('every failure code is produced by the right response', () => {
  const cases: [IssueCode, () => MockHttp, string?][] = [
    ['HTTP_404', () => always(() => reply('<html>nope</html>', 404))],
    ['HTTP_404', () => always(() => arcgisErr(404, 'Service Zoning/MapServer not found', 404)), 'ArcGIS JSON 404'],
    ['HTTP_410', () => always(() => reply('gone', 410))],
    ['HTTP_401_403', () => always(() => reply('forbidden', 403))],
    ['HTTP_401_403', () => always(() => reply('unauthorised', 401))],
    ['HTTP_401_403', () => always(() => arcgisErr(403, 'Forbidden')), 'ArcGIS 403 inside HTTP 200'],
    ['TOKEN_REQUIRED', () => always(() => arcgisErr(499, 'Token Required')), '499 inside HTTP 200'],
    ['TOKEN_REQUIRED', () => always(() => arcgisErr(498, 'Invalid token')), '498 inside HTTP 200'],
    ['TOKEN_REQUIRED', () => always(() => arcgisErr(499, 'Token Required', 499)), '499 with HTTP 499'],
    ['NOT_ARCGIS', () => always(() => reply('<!DOCTYPE html><html><body>City of Testville</body></html>')), 'HTML page with HTTP 200'],
    ['NOT_ARCGIS', () => always(() => reply('plain words', 200, { 'content-type': 'text/plain' })), 'non-JSON'],
    ['NOT_ARCGIS', () => always(() => reply({ hello: 'world' })), 'JSON that is not ArcGIS'],
    ['NOT_ARCGIS', () => always(() => reply('{"truncated":', 200, { 'content-type': 'application/json' })), 'broken JSON'],
    ['NOT_ARCGIS', () => always(() => new HttpError('TOO_LARGE', 'too big')), 'over the size limit'],
    ['HTTP_429', () => always(() => reply('slow down', 429))],
    ['HTTP_5XX', () => always(() => reply('boom', 503))],
    ['HTTP_5XX', () => always(() => reply('boom', 500))],
    ['SERVICE_STOPPED', () => always(() => arcgisErr(500, 'Service Planning/Zoning/MapServer not started', 500)), 'not started'],
    ['SERVICE_STOPPED', () => always(() => reply({ error: { code: 500, message: 'The service is stopped.' } }, 500))],
    ['TIMEOUT', () => always(() => new HttpError('TIMEOUT', 'timed out'))],
    ['DNS_FAIL', () => always(() => new HttpError('DNS_FAIL', 'ENOTFOUND'))],
    ['SSL_ERROR', () => always(() => new HttpError('SSL_ERROR', 'CERT_HAS_EXPIRED'))],
    ['REDIRECT_LOOP', () => always(() => new HttpError('REDIRECT_LOOP', 'too many'))],
    ['CONNECTION_FAILED', () => always(() => new HttpError('CONNECTION_FAILED', 'ECONNRESET'))],
    ['CORS_BLOCKED', () => always(() => new HttpError('CORS_BLOCKED', 'Failed to fetch'))],
    ['URL_MALFORMED', () => always(() => new HttpError('BLOCKED_HOST', 'private')), 'private address refused'],
    ['ARCGIS_ERROR', () => always(() => arcgisErr(400, 'Unable to complete operation.')), 'other ArcGIS error'],
    ['URL_MALFORMED', () => always(() => arcgisErr(400, 'Invalid URL Invalid URL.')), 'ArcGIS says Invalid URL (typo in the link)'],
    ['NO_LAYERS', () => new MockHttp([[/./, () => reply({ currentVersion: 10.9, layers: [], tables: [] })]])],
  ];

  for (const [code, mk, label] of cases) {
    it(`${code}${label ? ` (${label})` : ''}`, async () => {
      const res = await run(mk());
      expect(res.status).toBe(code);
      expect(res.issues[0].code).toBe(code);
      expect(res.issueReason.length).toBeGreaterThan(10);
      expect(res.primaryDate).toBe('None');
      expect(isFailure(res.status)).toBe(true);
    });
  }

  it('499 reason is the plain-English text from the PRD', async () => {
    const res = await run(always(() => arcgisErr(499)));
    expect(res.issueReason).toBe('Server returned a login-required error (code 499). This service is private.');
  });

  it('URL_EMPTY and URL_MALFORMED never touch the network', async () => {
    const http = always(() => reply({}));
    expect((await run(http, '')).status).toBe('URL_EMPTY');
    expect((await run(http, '   ')).status).toBe('URL_EMPTY');
    for (const bad of ['N/A', 'see city website', 'ftp://gis.city.gov/x', 'http://', 'zoning map coming soon']) {
      expect((await run(http, bad)).status, bad).toBe('URL_MALFORMED');
    }
    expect(http.calls).toHaveLength(0);
  });

  it('APP_URL_UNRESOLVED when the viewer item cannot be found', async () => {
    const http = always(() => reply({}));
    for (const u of [
      'https://experience.arcgis.com/experience/0123456789abcdef0123456789abcdef',
      'https://city.maps.arcgis.com/apps/webappviewer/index.html?id=0123456789abcdef0123456789abcdef',
      'https://www.arcgis.com/home/item.html?id=0123456789abcdef0123456789abcdef',
    ]) {
      expect((await run(http, u)).status, u).toBe('APP_URL_UNRESOLVED');
    }
  });

  it('a services folder is NO_LAYERS with the service names in the reason', async () => {
    const http = always(() => reply({ currentVersion: 10.9, folders: [], services: [{ name: 'Zoning', type: 'MapServer' }, { name: 'Parcels', type: 'FeatureServer' }] }));
    const res = await run(http, 'https://gis.testville.gov/arcgis/rest/services');
    expect(res.status).toBe('NO_LAYERS');
    expect(res.issueReason).toContain('Zoning (MapServer)');
  });
});

describe('retries', () => {
  it('retries TIMEOUT twice then reports it (3 attempts, Retries = 2)', async () => {
    const http = always(() => new HttpError('TIMEOUT', 'Headers Timeout Error'));
    const res = await run(http);
    expect(http.calls).toHaveLength(3);
    expect(res.retries).toBe(2);
    expect(res.status).toBe('TIMEOUT');
    expect(res.issueReason).toContain(`did not finish responding within ${rawConfig.timeouts.totalMs} ms`);
    expect(res.issueReason).toContain('Failed request: https://gis.testville.gov/arcgis/rest/services/Planning/Zoning/MapServer?f=json');
    expect(res.issueReason).toContain('tried 3 times');
    expect(res.issueReason).toContain('Headers Timeout Error');
  });

  it('a connect-level TIMEOUT keeps retrying, then reports it with guidance to re-check in the browser', async () => {
    const http = always(() => new HttpError('TIMEOUT', 'Connect Timeout Error'));
    const res = await run(http);
    expect(http.calls).toHaveLength(3); // testConfig retries.max = 2 -> 3 attempts; the slow server is given every chance
    expect(res.retries).toBe(2);
    expect(res.status).toBe('TIMEOUT');
    expect(res.issueReason).toContain('did not accept a connection');
    expect(res.issueReason).toContain('Re-check failed in browser');
  });

  it('retries 429 then succeeds', async () => {
    const ok = zoningService();
    let n = 0;
    const http = new MockHttp([[/./, async (url) => (++n <= 2 ? reply('slow', 429, { 'retry-after': '0' }) : ok.get(url))]]);
    const res = await run(http);
    expect(res.status).toBe('OK');
    expect(res.retries).toBe(2);
  });

  it('retries 5xx then reports HTTP_5XX', async () => {
    const http = always(() => reply('x', 502));
    const res = await run(http);
    expect(http.calls).toHaveLength(3);
    expect(res.status).toBe('HTTP_5XX');
  });

  it.each([
    ['DNS_FAIL', new HttpError('DNS_FAIL', 'x')],
    ['SSL_ERROR', new HttpError('SSL_ERROR', 'x')],
    ['404', null],
    ['499', null],
  ])('does not retry %s', async (_name, err) => {
    const http = err ? always(() => err) : _name === '404' ? always(() => reply('x', 404)) : always(() => arcgisErr(499));
    await run(http);
    expect(http.calls).toHaveLength(1);
  });

  it('honours Retry-After, capped by the maximum delay', async () => {
    const delays: number[] = [];
    const http = new MockHttp([[/./, () => reply('slow', 429, { 'retry-after': '9999' })]]);
    await checkMap(row(SVC), { http, config: testConfig({ retries: { max: 1, baseDelayMs: 1, maxDelayMs: 50 } }), now: fixedNow, sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([50]);
  });

  it('a cancelled run throws AbortedError instead of recording a failure', async () => {
    const ac = new AbortController();
    const http = always(() => {
      ac.abort();
      return new HttpError('TIMEOUT', 'x');
    });
    await expect(checkMap(row(SVC), { http, config: testConfig(), now: fixedNow, sleep: noSleep, signal: ac.signal })).rejects.toBeInstanceOf(AbortedError);
  });
});

describe('partial failures after the service loads', () => {
  it('one broken layer does not fail the map; it is shown in Layer Details and raised as an issue note', async () => {
    // Both layers are zoning-like, so the broken one (listed first) is tried before the good one.
    const goodLayer = { id: 1, name: 'Zoning Districts', type: 'Feature Layer', capabilities: 'Query', fields: [{ name: 'EditDate', type: 'esriFieldTypeDate' }] };
    const http = new MockHttp([
      [/\/query\?/, () => reply({ features: [{ attributes: { max_d: Date.UTC(2022, 0, 5), min_d: Date.UTC(2020, 0, 5), nn_count: 3 } }] })],
      [/\/MapServer\/0\?f=json$/, () => reply('boom', 500)],
      [/\/MapServer\/1\?f=json$/, () => reply(goodLayer)],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'Zoning Overlay' }, { id: 1, name: 'Zoning Districts' }] })],
    ]);
    const res = await run(http);
    expect(res.status).toBe('OK');
    expect(res.primaryDate).toBe('2022-01-05');
    expect(res.issueReason).toContain('1 of 2 layer(s) could not be read');
    expect(res.layers.find((l) => l.id === 0)?.error).toBeTruthy();
  });

  it('every layer broken and no date anywhere reports the real failure', async () => {
    const http = new MockHttp([
      [/\/MapServer\/\d\?f=json$/, () => arcgisErr(499, 'Token Required')],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 0, name: 'A' }, { id: 1, name: 'B' }] })],
    ]);
    expect((await run(http)).status).toBe('TOKEN_REQUIRED');
  });

  it('the single layer a URL points at failing is the map failing', async () => {
    const http = new MockHttp([
      [/\/MapServer\/4\?f=json$/, () => reply('x', 404)],
      [/\/MapServer\?f=json$/, () => reply({ currentVersion: 10.9, layers: [{ id: 4, name: 'Z' }] })],
    ]);
    expect((await run(http, `${SVC}/4`)).status).toBe('HTTP_404');
  });

  it('a duplicate flag from the sheet rides along without changing the status', async () => {
    const res = await run(zoningService(), SVC, { preIssues: [{ code: 'DUPLICATE_URL', reason: 'This link appears 2 times (row 2, row 7).' }] });
    expect(res.status).toBe('OK');
    expect(res.issues.map((i) => i.code)).toEqual(['DUPLICATE_URL']);
    expect(isFailure(res.status)).toBe(false);
  });

  it('a service without date fields is OK_NO_DATE, not an issue', async () => {
    const res = await run(zoningService({ fieldName: 'Ord_Date' }));
    expect(res.status).toBe('OK_NO_DATE');
    expect(isFailure(res.status)).toBe(false);
  });
});

describe('taxonomy', () => {
  it('every code that can appear has a meaning and a suggested action', () => {
    for (const [code, info] of Object.entries(ISSUE_INFO)) {
      expect(info.meaning, code).toBeTruthy();
      expect(info.action, code).toBeTruthy();
    }
  });

  it('network-path failures (fixable by re-checking in the browser) are classified, content problems are not', () => {
    for (const c of ['TIMEOUT', 'CONNECTION_FAILED', 'HOST_UNREACHABLE', 'HTTP_401_403', 'SSL_ERROR', 'DNS_FAIL'] as const) {
      expect(isNetworkPathIssue(c), c).toBe(true);
    }
    for (const c of ['HTTP_404', 'NO_LAYERS', 'TOKEN_REQUIRED', 'URL_MALFORMED', 'NOT_ARCGIS', 'OK', 'OK_NO_DATE', 'CORS_BLOCKED'] as const) {
      expect(isNetworkPathIssue(c), c).toBe(false);
    }
  });
});
