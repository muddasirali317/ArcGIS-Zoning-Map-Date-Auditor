import type { IssueCode } from './types';

export const TOOL_VERSION = '0.1.0-phase1';

export interface IssueInfo {
  meaning: string;
  action: string;
}

/** PRD section 7, plus the two codes marked as additions in types.ts. */
export const ISSUE_INFO: Record<IssueCode, IssueInfo> = {
  OK: { meaning: 'Loaded, date found', action: 'None' },
  OK_NO_DATE: { meaning: 'Loaded, no date anywhere (Date = None)', action: 'Check the metadata page or contact the city' },
  URL_EMPTY: { meaning: 'Missing link', action: 'Fix the cell in the sheet' },
  URL_MALFORMED: { meaning: 'Invalid link', action: 'Fix the cell in the sheet' },
  NOT_ARCGIS: { meaning: 'Server returned HTML or non-ArcGIS content', action: 'Find the REST endpoint' },
  HTTP_404: { meaning: 'Service moved or deleted', action: 'Search for the new endpoint' },
  HTTP_410: { meaning: 'Service moved or deleted', action: 'Search for the new endpoint' },
  HTTP_401_403: { meaning: 'Secured service, or blocked from this location', action: 'Needs credentials (mark manual), or re-check through a VPN if the city blocks non-US traffic' },
  TOKEN_REQUIRED: { meaning: 'Secured service', action: 'Needs credentials, mark manual' },
  HTTP_429: { meaning: 'Rate limited', action: 'Auto-retry later, lower host concurrency' },
  HTTP_5XX: { meaning: 'Server error', action: 'Auto-retry, then flag' },
  TIMEOUT: { meaning: 'No response within the limit', action: 'Retry later; if the city blocks non-US traffic, re-check through a VPN' },
  DNS_FAIL: { meaning: 'Domain gone', action: 'Report; the domain may have changed' },
  SSL_ERROR: { meaning: 'Bad certificate', action: 'Report; open the endpoint manually' },
  CORS_BLOCKED: { meaning: 'Browser could not read it', action: 'Re-check from the server instead' },
  SERVICE_STOPPED: { meaning: 'Service exists but is not running', action: 'Contact the owner' },
  NO_LAYERS: { meaning: 'Service has no layers', action: 'Manual review' },
  APP_URL_UNRESOLVED: { meaning: 'Viewer link, could not find the service', action: 'Provide the REST link' },
  REDIRECT_LOOP: { meaning: 'Too many redirects', action: 'Manual' },
  DUPLICATE_URL: { meaning: 'Same link appears more than once', action: 'Informational' },
  DATE_SENTINEL_IGNORED: { meaning: 'A placeholder date was ignored', action: 'Review' },
  DATE_IN_FUTURE: { meaning: 'A date after today was found', action: 'Review; may be a genuine effective date' },
  AMBIGUOUS_FORMAT: { meaning: 'A text date could not be read unambiguously', action: 'Review' },
  MAP_RENDER_FAILED: { meaning: 'Data ok, viewer could not draw tiles', action: 'Open the endpoint directly' },
  HOST_UNREACHABLE: { meaning: 'Server failed repeatedly, so the rest of its maps were skipped', action: 'Use Re-check failed to retry; if the city blocks non-US traffic, re-check through a VPN' },
  CONNECTION_FAILED: { meaning: 'Connection refused or reset', action: 'Retry; if the city blocks non-US traffic, re-check through a VPN' },
  ARCGIS_ERROR: { meaning: 'ArcGIS returned an error', action: 'Read the reason; open the endpoint manually' },
};

export function isWarning(code: IssueCode): boolean {
  return code === 'DUPLICATE_URL' || code === 'DATE_SENTINEL_IGNORED' || code === 'DATE_IN_FUTURE' || code === 'AMBIGUOUS_FORMAT';
}

/**
 * Codes where the source link itself never opened to a usable response: a bad address, a dead or
 * unreachable host, an HTTP error, or a non-ArcGIS page. These feed the CSV's "Issue 2" column;
 * everything else that is not OK (secured services, stopped services, no layers, render failures,
 * ArcGIS errors, date warnings) describes the map once it did open and feeds the "Issue" column.
 */
const LINK_ISSUE_CODES = new Set<IssueCode>([
  'URL_EMPTY', 'URL_MALFORMED', 'NOT_ARCGIS', 'HTTP_404', 'HTTP_410', 'HTTP_429', 'HTTP_5XX',
  'TIMEOUT', 'DNS_FAIL', 'SSL_ERROR', 'CORS_BLOCKED', 'REDIRECT_LOOP', 'HOST_UNREACHABLE', 'CONNECTION_FAILED',
]);

export function isLinkIssue(code: IssueCode): boolean {
  return LINK_ISSUE_CODES.has(code);
}

/**
 * Failures that a different network path could fix: the server could not reach the host, or the host
 * answered the server with a block (a 401/403 aimed at the server's IP/region, or a dropped connection).
 * Re-running these from the user's browser — which has its own route/VPN — often succeeds. Content
 * problems (real 404, no layers, token-secured, malformed URL) are never in here: the browser can't help.
 */
const NETWORK_PATH_CODES = new Set<IssueCode>([
  'TIMEOUT', 'CONNECTION_FAILED', 'HOST_UNREACHABLE', 'HTTP_401_403', 'SSL_ERROR', 'DNS_FAIL', 'HTTP_429', 'HTTP_5XX',
]);

export function isNetworkPathIssue(code: IssueCode): boolean {
  return NETWORK_PATH_CODES.has(code);
}

/** Codes that count as an "Issue" in the summary. OK and OK_NO_DATE loaded successfully; warnings are informational. */
export function isFailure(code: IssueCode): boolean {
  return code !== 'OK' && code !== 'OK_NO_DATE' && !isWarning(code);
}
