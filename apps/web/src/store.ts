import { buildRows, NO_FILTERS, type CheckResult, type CheckRow, type ColumnMapping, type Filters, type QueueStats, type RawConfig } from '@zoning/core';
import type { AuthStatus, SheetPayload, SyncCounts } from './api';

export interface RemovedRow {
  row: CheckRow;
  result: CheckResult | null;
}

export interface State {
  sheetUrl: string;
  /** Present after a Sync in this session (needed for the column mapping screen). */
  sheet: SheetPayload | null;
  sheetKey: string | null;
  rows: CheckRow[];
  cleaning: { blankDropped: number; split: number; duplicates: number } | null;
  results: Record<string, CheckResult>;
  removed: RemovedRow[];
  syncCounts: SyncCounts | null;
  runId: string | null;
  stats: QueueStats | null;
  startedAt: number | null;
  filters: Filters;
  selectedId: string | null;
  syncing: boolean;
  error: string | null;
  lastSynced: string | null;
  config: RawConfig | null;
  /** Google sign-in state; null until asked. */
  auth: AuthStatus | null;
  /** The last Sync failed because the sheet is private. */
  needsSignIn: { canSignIn: boolean } | null;
  browserCheck: { total: number; done: number; running: boolean } | null;
}

export const initialState: State = {
  sheetUrl: '',
  sheet: null,
  sheetKey: null,
  rows: [],
  cleaning: null,
  results: {},
  removed: [],
  syncCounts: null,
  runId: null,
  stats: null,
  startedAt: null,
  filters: NO_FILTERS,
  selectedId: null,
  syncing: false,
  error: null,
  lastSynced: null,
  config: null,
  auth: null,
  needsSignIn: null,
  browserCheck: null,
};

export type Action =
  | { type: 'set'; patch: Partial<State> }
  | { type: 'sheet'; sheet: SheetPayload; mapping: ColumnMapping; sheetKey: string }
  | { type: 'mapping'; mapping: ColumnMapping }
  | { type: 'loaded'; rows: CheckRow[]; results: CheckResult[]; removed: RemovedRow[]; syncedAt: string; sheetKey: string; sheet: SheetPayload | null }
  | { type: 'synced'; results: CheckResult[]; removed: RemovedRow[]; counts: SyncCounts; runId: string | null }
  | { type: 'results'; list: CheckResult[] }
  | { type: 'stats'; stats: QueueStats }
  | { type: 'patchResult'; id: string; patch: Partial<CheckResult> }
  | { type: 'filters'; patch: Partial<Filters> }
  | { type: 'browserProgress'; patch: Partial<NonNullable<State['browserCheck']>> | null };

function rebuild(sheet: SheetPayload, mapping: ColumnMapping) {
  const built = buildRows(sheet.table, mapping);
  return { rows: built.rows, cleaning: { blankDropped: built.blankDropped, split: built.split, duplicates: built.duplicates } };
}

const byId = (list: CheckResult[]) => Object.fromEntries(list.map((r) => [r.id, r]));

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'set':
      return { ...s, ...a.patch };
    case 'sheet': {
      const sheet = { ...a.sheet, mapping: a.mapping };
      return { ...s, sheet, sheetKey: a.sheetKey, ...rebuild(sheet, a.mapping), selectedId: null, error: null, syncing: false, lastSynced: new Date().toISOString() };
    }
    case 'mapping': {
      if (!s.sheet) return s;
      const sheet = { ...s.sheet, mapping: a.mapping };
      return { ...s, sheet, ...rebuild(sheet, a.mapping), results: {}, selectedId: null };
    }
    case 'loaded':
      return { ...s, rows: a.rows, results: byId(a.results), removed: a.removed, lastSynced: a.syncedAt, sheetKey: a.sheetKey, sheet: a.sheet, cleaning: null, selectedId: null };
    case 'synced':
      return { ...s, results: byId(a.results), removed: a.removed, syncCounts: a.counts, runId: a.runId, stats: null, startedAt: a.runId ? Date.now() : null, error: null, syncing: false };
    case 'results': {
      const results = { ...s.results };
      for (const r of a.list) results[r.id] = r;
      return { ...s, results };
    }
    case 'stats':
      return { ...s, stats: a.stats };
    case 'patchResult': {
      const cur = s.results[a.id];
      return cur ? { ...s, results: { ...s.results, [a.id]: { ...cur, ...a.patch } } } : s;
    }
    case 'filters':
      return { ...s, filters: { ...s.filters, ...a.patch } };
    case 'browserProgress':
      return { ...s, browserCheck: a.patch === null ? null : { total: 0, done: 0, running: true, ...s.browserCheck, ...a.patch } };
  }
}

const MAPPING_KEY = (sheetId: string, gid: string) => `zoning-auditor:mapping:${sheetId}:${gid}`;
const LAST_URL_KEY = 'zoning-auditor:last-sheet-url';

export function loadSavedMapping(sheetId: string, gid: string): ColumnMapping | null {
  try {
    const raw = localStorage.getItem(MAPPING_KEY(sheetId, gid));
    return raw ? (JSON.parse(raw) as ColumnMapping) : null;
  } catch {
    return null;
  }
}

export function saveMapping(sheetId: string, gid: string, mapping: ColumnMapping) {
  try {
    localStorage.setItem(MAPPING_KEY(sheetId, gid), JSON.stringify(mapping));
  } catch {
    /* storage unavailable: the mapping is simply not remembered */
  }
}

export const loadLastUrl = (): string => {
  try {
    return localStorage.getItem(LAST_URL_KEY) ?? '';
  } catch {
    return '';
  }
};
export const saveLastUrl = (url: string) => {
  try {
    localStorage.setItem(LAST_URL_KEY, url);
  } catch {
    /* ignore */
  }
};

const THEME_KEY = 'zoning-auditor:theme';
export type ThemeChoice = 'system' | 'light' | 'dark';

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
    return 'dark'; // first-time default: the tool ships looking like its dark data-dashboard design
  } catch {
    return 'dark';
  }
}

/** Applies the choice to the page. 'system' follows the operating system setting. */
export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* not remembered */
  }
}

const SPLIT_KEY = 'zoning-auditor:split';

/** Width of the results table as a percentage of the workspace (the map takes the rest). */
export function loadSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 25 && v <= 70 ? v : 48;
  } catch {
    return 48;
  }
}

export function saveSplit(pct: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(pct)));
  } catch {
    /* not remembered */
  }
}
