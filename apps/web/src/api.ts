import type { CheckResult, CheckRow, ColumnMapping, QueueStats, RawConfig, SyncMode } from '@zoning/core';

export interface SheetPayload {
  sheetId: string;
  gid: string;
  table: string[][];
  mapping: ColumnMapping;
}

export interface SyncCounts {
  total: number;
  unchanged: number;
  changed: number;
  added: number;
  removed: number;
  queued: number;
}

export interface SyncResponse {
  runId: string | null;
  counts: SyncCounts;
  results: CheckResult[];
  removed: { row: CheckRow; result: CheckResult | null }[];
}

export interface StoredState {
  table: string[][] | null;
  mapping: ColumnMapping | null;
  url: string;
  rows: CheckRow[];
  results: CheckResult[];
  removed: { row: CheckRow; result: CheckResult | null }[];
  syncedAt: string;
}

/** An error from the server that keeps its machine-readable fields (code, canSignIn, …). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, any>) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data);
  return data as T;
}

export const syncSheet = (url: string) => call<SheetPayload>('POST', '/api/sheet', { url });
export const syncRows = (sheetKey: string, sheetUrl: string, rows: CheckRow[], mode: SyncMode, extras: { table?: string[][]; mapping?: ColumnMapping } = {}) =>
  call<SyncResponse>('POST', '/api/sync', { sheetKey, sheetUrl, rows, mode, ...extras });
export const controlRun = (id: string, action: 'pause' | 'resume' | 'cancel') => call<{ stats: QueueStats }>('POST', `/api/runs/${id}/${action}`);
export const saveResults = (sheetKey: string, items: { fingerprint: string; result: CheckResult }[]) => call<{ saved: number }>('PUT', '/api/results', { sheetKey, items });

export async function loadState(sheetKey: string): Promise<StoredState | null> {
  const res = await fetch(`/api/state?sheetKey=${encodeURIComponent(sheetKey)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Could not load the saved state.');
  return res.json();
}

export async function fetchConfig(): Promise<{ config: RawConfig; upstreamProxy: boolean }> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Could not load the server configuration. Is the server running?');
  return res.json();
}

export interface RunStream {
  close(): void;
}

/** Subscribe to a run. Result events are batched so 1,000 rows do not cause 1,000 re-renders. */
export function openRunStream(runId: string, on: { results(list: CheckResult[]): void; stats(s: QueueStats): void }): RunStream {
  const es = new EventSource(`/api/runs/${runId}/events`);
  let buffer: CheckResult[] = [];
  const flush = () => {
    if (buffer.length) {
      const list = buffer;
      buffer = [];
      on.results(list);
    }
  };
  const timer = setInterval(flush, 200);
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    on.results(d.results);
    on.stats(d.stats);
  });
  es.addEventListener('result', (e) => buffer.push(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('progress', (e) => {
    const stats: QueueStats = JSON.parse((e as MessageEvent).data);
    if (stats.state === 'done' || stats.state === 'cancelled') flush();
    on.stats(stats);
  });
  return {
    close() {
      clearInterval(timer);
      flush();
      es.close();
    },
  };
}

export interface AuthStatus {
  configured: boolean;
  signedIn: boolean;
  canWrite: boolean;
}
export const authStatus = () => call<AuthStatus>('GET', '/api/auth/status');
export const signOutGoogle = () => call<AuthStatus>('POST', '/api/auth/signout');

export interface WriteBackSummary {
  rows: number;
  checked: number;
  columns: string[];
  replacesExisting: string[];
}
export const writeBack = (sheetKey: string, confirm: boolean, dateFormat: 'iso' | 'dmy') =>
  call<{ dryRun?: boolean; written?: boolean; summary: WriteBackSummary }>('POST', '/api/sheets/write-back', { sheetKey, confirm, dateFormat });

export const addDateFields = (names: string[]) => call<{ added: string[]; skipped: string[] }>('POST', '/api/config/date-fields', { names });
