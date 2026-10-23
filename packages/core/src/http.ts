/**
 * The engine talks to servers only through this interface, so the same code runs on the
 * Node backend (undici, SSRF-guarded) and inside the browser (fetch, for geo-blocked cities
 * reachable only through the user's browser VPN) and can be mocked in tests.
 */

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
  /** Final URL after redirects. */
  url: string;
  /** Wall time of the request in ms. */
  ms: number;
}

export type HttpErrorCode =
  | 'TIMEOUT'
  | 'DNS_FAIL'
  | 'SSL_ERROR'
  | 'REDIRECT_LOOP'
  | 'CONNECTION_FAILED'
  | 'CORS_BLOCKED'
  | 'TOO_LARGE'
  | 'BLOCKED_HOST';

export class HttpError extends Error {
  constructor(
    public code: HttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpClient {
  get(url: string, opts?: { signal?: AbortSignal }): Promise<HttpResponse>;
}

/** Thrown when a run is cancelled mid-check. The queue discards the row instead of recording a failure. */
export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}
