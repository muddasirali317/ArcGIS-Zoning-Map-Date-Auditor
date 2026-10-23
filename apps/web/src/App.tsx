import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  applyFilters, buildFullCsv, buildIssuesCsv, buildRows, buildSheetReadyCsv, isFailure, isNetworkPathIssue, localDate, normalizeName, suggestDateFields, summarize,
  type CheckResult, type CheckRow, type ColumnMapping, type DateFormat, type SyncMode,
} from '@zoning/core';
import { addDateFields, ApiError, authStatus, controlRun, fetchConfig, loadState, openRunStream, saveResults, signOutGoogle, syncRows, syncSheet, type RunStream } from './api';
import { recheckInBrowser, type BrowserCheckHandle } from './browserCheck';
import { BrandBar, CityPanel, DetailTabs, FreshnessLegend, IssueSummary, MappingPanel, PrimaryDateCard, RemovedPanel, RunControls, SheetPanel, SummaryCards, TrayItem } from './components';
import { FilterBar } from './FilterBar';
import { ExportMenu, GoogleBar, PreviewCopyDialog, SuggestionsPanel, ThemeToggle, WriteBackDialog } from './Phase3Panels';
import { ResultsTable } from './ResultsTable';
import { applyTheme, initialState, loadLastUrl, loadSavedMapping, loadSplit, loadTheme, reducer, saveLastUrl, saveMapping, saveSplit, type ThemeChoice } from './store';

// Leaflet is loaded only when a map is first opened, so the table appears quickly.
const MapViewer = lazy(() => import('./MapViewer').then((m) => ({ default: m.MapViewer })));

const keyOf = (sheetId: string, gid: string) => `${sheetId}:${gid}`;

function sheetKeyFromUrl(url: string): string | null {
  const m = /docs\.google\.com\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/.exec(url);
  if (!m) return null;
  return keyOf(m[1], /[#?&]gid=(\d+)/.exec(url)?.[1] ?? '0');
}

function download(name: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function App() {
  const [s, dispatch] = useReducer(reducer, initialState);
  const [tab, setTab] = useState<'results' | 'cities'>('results');
  const [order, setOrder] = useState<string[]>([]);
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const [dateFormat, setDateFormat] = useState<DateFormat>('iso');
  const [writeBackOpen, setWriteBackOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [autoBrowser, setAutoBrowser] = useState(true);
  const autoBrowserRun = useRef<string | null>(null);
  const [split, setSplit] = useState(loadSplit);
  const workspace = useRef<HTMLDivElement>(null);
  const [waitingGoogle, setWaitingGoogle] = useState(false);
  const [fieldsAdded, setFieldsAdded] = useState(false);
  const [busyFields, setBusyFields] = useState(false);
  const stream = useRef<RunStream | null>(null);
  const browser = useRef<BrowserCheckHandle | null>(null);
  const stateRef = useRef(s);
  stateRef.current = s;
  const dirty = useRef(new Set<string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const fail = useCallback((e: unknown) => dispatch({ type: 'set', patch: { error: e instanceof Error ? e.message : String(e), syncing: false } }), []);

  useEffect(() => applyTheme(theme), [theme]);

  // ---- saving analyst edits and browser re-checks ---------------------------
  const flush = useCallback(() => {
    const st = stateRef.current;
    if (!st.sheetKey) return;
    const items = [...dirty.current].flatMap((id) => {
      const row = st.rows.find((r) => r.id === id);
      const result = st.results[id];
      return row && result ? [{ fingerprint: row.fingerprint, result }] : [];
    });
    dirty.current.clear();
    if (items.length) saveResults(st.sheetKey, items).catch(fail);
  }, [fail]);

  const markDirty = useCallback(
    (ids: string[]) => {
      ids.forEach((id) => dirty.current.add(id));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, 600);
    },
    [flush],
  );

  const patchResult = useCallback(
    (id: string, patch: Partial<CheckResult>) => {
      dispatch({ type: 'patchResult', id, patch });
      markDirty([id]);
    },
    [markDirty],
  );

  // ---- start-up: config, Google status, and the last sheet's stored state ----
  useEffect(() => {
    fetchConfig().then((c) => dispatch({ type: 'set', patch: { config: c.config } }), fail);
    authStatus().then((auth) => dispatch({ type: 'set', patch: { auth } }), () => undefined);
    const url = loadLastUrl();
    const key = url ? sheetKeyFromUrl(url) : null;
    if (url) dispatch({ type: 'set', patch: { sheetUrl: url } });
    if (key) {
      loadState(key)
        .then((st) => {
          if (!st) return;
          const [sheetId, gid] = key.split(':');
          const sheet = st.table && st.mapping ? { sheetId, gid, table: st.table, mapping: st.mapping } : null;
          dispatch({ type: 'loaded', rows: st.rows, results: st.results, removed: st.removed, syncedAt: st.syncedAt, sheetKey: key, sheet });
        })
        .catch(() => undefined);
    }
    return () => {
      flush();
      stream.current?.close();
      browser.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- runs ----------------------------------------------------------------
  const watchRun = useCallback((runId: string) => {
    stream.current?.close();
    stream.current = openRunStream(runId, {
      results: (list) => dispatch({ type: 'results', list }),
      stats: (stats) => dispatch({ type: 'stats', stats }),
    });
  }, []);

  const stopRunIfActive = useCallback(async () => {
    const st = stateRef.current;
    const state = st.stats?.state;
    if (st.runId && (state === 'running' || state === 'paused')) await controlRun(st.runId, 'cancel').catch(() => undefined);
    stream.current?.close();
  }, []);

  /** Send the rows to the server; it queues only what the mode asks for and returns stored results to show now. */
  const runSync = useCallback(
    async (rows: CheckRow[], mode: SyncMode, sheetKey: string, sheetUrl: string, extras: { table?: string[][]; mapping?: ColumnMapping } = {}) => {
      await stopRunIfActive();
      flush();
      const res = await syncRows(sheetKey, sheetUrl, rows, mode, extras);
      dispatch({ type: 'synced', results: res.results, removed: res.removed, counts: res.counts, runId: res.runId });
      if (res.runId) watchRun(res.runId);
    },
    [flush, stopRunIfActive, watchRun],
  );

  const sync = useCallback(async () => {
    dispatch({ type: 'set', patch: { syncing: true, error: null, needsSignIn: null } });
    try {
      await stopRunIfActive();
      const url = stateRef.current.sheetUrl.trim();
      const sheet = await syncSheet(url);
      const key = keyOf(sheet.sheetId, sheet.gid);
      const mapping = loadSavedMapping(sheet.sheetId, sheet.gid) ?? sheet.mapping;
      saveLastUrl(url);
      dispatch({ type: 'sheet', sheet, mapping, sheetKey: key });
      const built = buildRows(sheet.table, mapping);
      if (mapping.url !== null && built.rows.length > 0) await runSync(built.rows, 'changed', key, url, { table: sheet.table, mapping });
      else dispatch({ type: 'set', patch: { syncing: false } });
    } catch (e) {
      if (e instanceof ApiError && e.data.code === 'SHEET_PRIVATE') {
        dispatch({ type: 'set', patch: { syncing: false, needsSignIn: { canSignIn: Boolean(e.data.canSignIn) }, error: null } });
        authStatus().then((auth) => dispatch({ type: 'set', patch: { auth } }), () => undefined);
      } else fail(e);
    }
  }, [fail, runSync, stopRunIfActive]);

  const recheck = useCallback(
    async (mode: SyncMode) => {
      const st = stateRef.current;
      if (!st.sheetKey || st.rows.length === 0) return;
      try {
        await runSync(st.rows, mode, st.sheetKey, st.sheetUrl, st.sheet ? { table: st.sheet.table, mapping: st.sheet.mapping } : {});
      } catch (e) {
        fail(e);
      }
    },
    [fail, runSync],
  );

  const changeMapping = useCallback(
    async (m: ColumnMapping) => {
      const st = stateRef.current;
      if (!st.sheet || !st.sheetKey) return;
      saveMapping(st.sheet.sheetId, st.sheet.gid, m);
      await stopRunIfActive();
      dispatch({ type: 'mapping', mapping: m });
      const built = buildRows(st.sheet.table, m);
      // Rows whose City, State and link are unchanged get their stored result back; the rest are queued.
      if (m.url !== null && built.rows.length > 0) runSync(built.rows, 'changed', st.sheetKey, st.sheetUrl, { table: st.sheet.table, mapping: m }).catch(fail);
    },
    [fail, runSync, stopRunIfActive],
  );

  const control = useCallback((a: 'pause' | 'resume' | 'cancel') => stateRef.current.runId && controlRun(stateRef.current.runId!, a).catch(fail), [fail]);

  // ---- Google ------------------------------------------------------------------
  const signIn = useCallback(
    (write: boolean) => {
      window.open(`/api/auth/google/start${write ? '?write=1' : ''}`, '_blank');
      setWaitingGoogle(true);
      const started = Date.now();
      const poll = setInterval(async () => {
        const auth = await authStatus().catch(() => null);
        const done = auth && auth.signedIn && (!write || auth.canWrite);
        if (auth) dispatch({ type: 'set', patch: { auth } });
        if (done || Date.now() - started > 3 * 60_000) {
          clearInterval(poll);
          setWaitingGoogle(false);
          // a private sheet was waiting for this: read it now
          if (done && stateRef.current.needsSignIn) sync();
        }
      }, 1500);
    },
    [sync],
  );

  const signOut = useCallback(() => signOutGoogle().then((auth) => dispatch({ type: 'set', patch: { auth } }), fail), [fail]);

  // ---- derived data ---------------------------------------------------------
  const summary = useMemo(() => summarize(s.rows, s.results), [s.rows, s.results]);
  const display = useMemo(() => applyFilters(s.rows, s.results, s.filters), [s.rows, s.results, s.filters]);
  const navIds = order.length ? order : display.map((d) => d.row.id);
  const navIndex = s.selectedId ? navIds.indexOf(s.selectedId) : -1;
  const selected = useMemo(() => {
    const row = s.selectedId ? s.rows.find((r) => r.id === s.selectedId) : undefined;
    return row ? { row, result: s.results[row.id] } : null;
  }, [s.selectedId, s.rows, s.results]);
  const failedIds = useMemo(() => s.rows.filter((r) => s.results[r.id] && isFailure(s.results[r.id].status)).map((r) => r.id), [s.rows, s.results]);
  const suggestions = useMemo(
    () => suggestDateFields(Object.values(s.results), new Set((s.config?.dateFieldNames ?? []).map(normalizeName))),
    [s.results, s.config],
  );

  // ---- review flow ----------------------------------------------------------
  const select = useCallback((id: string | null) => dispatch({ type: 'set', patch: { selectedId: id } }), []);
  const step = useCallback(
    (delta: number) => {
      const ids = navIds;
      if (ids.length === 0) return;
      const i = stateRef.current.selectedId ? ids.indexOf(stateRef.current.selectedId) : -1;
      const next = Math.min(ids.length - 1, Math.max(0, i < 0 ? (delta > 0 ? 0 : ids.length - 1) : i + delta));
      select(ids[next]);
    },
    [navIds, select],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || el.getAttribute('role') === 'separator')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const markReviewed = useCallback(
    (advance: boolean) => {
      const id = stateRef.current.selectedId;
      if (!id || !stateRef.current.results[id]) return;
      const now = new Date();
      patchResult(id, { reviewDate: localDate(now), reviewedAt: now.toISOString(), manualReview: true });
      if (advance) step(1);
    },
    [patchResult, step],
  );

  const onRenderFailed = useCallback(
    (id: string, message: string) => {
      const r = stateRef.current.results[id];
      if (!r || r.issues.some((i) => i.code === 'MAP_RENDER_FAILED')) return;
      const issues = [...r.issues, { code: 'MAP_RENDER_FAILED' as const, reason: message }];
      patchResult(id, { issues, issueReason: issues.map((i) => i.reason).join(' | ') });
    },
    [patchResult],
  );

  // ---- export ---------------------------------------------------------------
  const stamp = new Date().toISOString().slice(0, 10);
  const checkedResults = () => s.rows.flatMap((r) => (s.results[r.id] ? [s.results[r.id]] : []));
  const exportFull = useCallback(() => { flush(); download(`zoning-audit-${stamp}.csv`, buildFullCsv(checkedResults())); }, [flush, s.rows, s.results, stamp]);
  const exportIssues = useCallback(() => { flush(); download(`zoning-audit-issues-${stamp}.csv`, buildIssuesCsv(checkedResults())); }, [flush, s.rows, s.results, stamp]);
  const exportSheetReady = useCallback(() => {
    flush();
    if (!s.sheet) return fail(new Error('Press Sync once so the tool has your sheet, then export again.'));
    download(`zoning-audit-sheet-ready-${stamp}.csv`, buildSheetReadyCsv(s.sheet.table, s.rows, s.results, dateFormat));
  }, [flush, s.sheet, s.rows, s.results, dateFormat, stamp, fail]);

  // ---- date-field suggestions -------------------------------------------------
  const addFields = useCallback(
    async (names: string[]) => {
      setBusyFields(true);
      try {
        const res = await addDateFields(names);
        const c = await fetchConfig();
        dispatch({ type: 'set', patch: { config: c.config } });
        if (res.added.length) setFieldsAdded(true);
        if (res.skipped.length) dispatch({ type: 'set', patch: { error: `Not added (already covered or not a valid field name): ${res.skipped.join(', ')}` } });
      } catch (e) {
        fail(e);
      } finally {
        setBusyFields(false);
      }
    },
    [fail],
  );

  // ---- re-check from the browser (VPN) ----------------------------------------
  const recheckBrowser = useCallback(
    (ids: string[]) => {
      const st = stateRef.current;
      if (!st.config || ids.length === 0) return;
      const wanted = new Set(ids);
      const rows = st.rows.filter((r) => wanted.has(r.id));
      dispatch({ type: 'browserProgress', patch: { total: rows.length, done: 0, running: true } });
      const handle = recheckInBrowser(rows, st.config, {
        result: (r: CheckResult) => {
          dispatch({ type: 'results', list: [r] });
          markDirty([r.id]);
        },
        progress: (stats) => dispatch({ type: 'browserProgress', patch: { done: stats.completed, total: stats.total } }),
      });
      browser.current = handle;
      handle.finished.then(() => dispatch({ type: 'browserProgress', patch: { running: false } }));
    },
    [markDirty],
  );

  // Maps the server could not reach (timeouts, connection refused, 401/403, DNS, SSL): the user's browser,
  // on its own route/VPN, often can. These are re-checked from the browser — automatically when enabled.
  const networkBlockedIds = useMemo(
    () => s.rows.filter((r) => s.results[r.id] && s.results[r.id].via !== 'browser' && isNetworkPathIssue(s.results[r.id].status)).map((r) => r.id),
    [s.rows, s.results],
  );

  useEffect(() => {
    if (!autoBrowser || s.stats?.state !== 'done' || !s.runId) return;
    if (autoBrowserRun.current === s.runId || s.browserCheck?.running || networkBlockedIds.length === 0) return;
    autoBrowserRun.current = s.runId; // one automatic browser pass per server run
    recheckBrowser(networkBlockedIds);
  }, [autoBrowser, s.stats?.state, s.runId, s.browserCheck?.running, networkBlockedIds, recheckBrowser]);

  // ---- table | map splitter (drag or arrow keys); the width is remembered ----------
  const moveSplit = useCallback((pct: number) => {
    const v = Math.min(70, Math.max(25, pct));
    setSplit(v);
    saveSplit(v);
  }, []);
  const dragSplit = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const box = workspace.current?.getBoundingClientRect();
      if (!box) return;
      const onMove = (ev: PointerEvent) => moveSplit(((ev.clientX - box.left) / box.width) * 100);
      const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
    },
    [moveSplit],
  );

  // After a run, date fields that look like "last updated" fields (and exist on maps that loaded without a date) are
  // added to the config automatically and those maps are checked again. Each name is tried once, so this cannot loop.
  const triedFields = useRef(new Set<string>());
  useEffect(() => {
    if (s.stats?.state !== 'done' || busyFields) return;
    const names = suggestions.filter((x) => x.likelihood === 'likely' && x.mapsWithoutDate > 0 && !triedFields.current.has(x.name)).map((x) => x.name);
    if (names.length === 0) return;
    names.forEach((n) => triedFields.current.add(n));
    addFields(names).then(() => recheck('nodate'));
  }, [s.stats?.state, suggestions, busyFields, addFields, recheck]);

  const pickCard = (card: typeof s.filters.card) => {
    dispatch({ type: 'filters', patch: { card, city: null } });
    setTab('results');
  };
  const hasRows = s.rows.length > 0;

  const active = s.stats?.state === 'running' || s.stats?.state === 'paused';

  return (
    <div className="app">
      <BrandBar
        s={s}
        actions={
          <>
            <ThemeToggle theme={theme} onChange={setTheme} />
            <button className="primary small" disabled={!s.sheet || Object.keys(s.results).length === 0} title={s.sheet ? '' : 'Sync once so the tool has your sheet'} onClick={() => setPreviewOpen(true)}>Review &amp; copy…</button>
            <ExportMenu checked={Object.keys(s.results).length} issues={summary.issues} hasSheet={!!s.sheet} dateFormat={dateFormat} onDateFormat={setDateFormat} onFull={exportFull} onIssues={exportIssues} onSheetReady={exportSheetReady} />
          </>
        }
      />

      <div className="command-row">
        <SheetPanel s={s} active={active} onUrl={(v) => dispatch({ type: 'set', patch: { sheetUrl: v } })} onSync={sync} />
        <RunControls s={s} pendingCount={summary.pending} failedCount={failedIds.length} onRecheck={recheck} onControl={control} onBrowserRecheck={() => recheckBrowser(failedIds)} />
        <SummaryCards summary={summary} active={s.filters.card} onPick={pickCard} />
      </div>

      <GoogleBar auth={s.auth} needsSignIn={s.needsSignIn} waiting={waitingGoogle} hasSheet={!!s.sheet && !!s.sheetKey} onSignIn={signIn} onSignOut={signOut} onWriteBack={() => setWriteBackOpen(true)} />
      {s.error && (
        <div className="banner error" role="alert">
          <span>{s.error}</span>
          <button className="small" onClick={() => dispatch({ type: 'set', patch: { error: null } })}>Dismiss</button>
        </div>
      )}
      <div className="strip-row">
        <IssueSummary results={s.results} />
        <div className="tray">
          {(s.browserCheck?.running || networkBlockedIds.length > 0) && (
            <TrayItem
              className="blocked"
              attention
              summary={s.browserCheck?.running ? <>Browser re-check {s.browserCheck.done ?? 0}/{s.browserCheck.total ?? 0}…</> : <>{networkBlockedIds.length} server-blocked</>}
            >
              <p>
                {s.browserCheck?.running
                  ? `Re-checking ${s.browserCheck.done ?? 0} of ${s.browserCheck.total ?? 0} server-blocked map(s) in your browser…`
                  : `${networkBlockedIds.length} map(s) the server could not reach (timeout or access-blocked). Your browser’s network (with your VPN) usually can.`}
              </p>
              <label className="small">
                <input type="checkbox" checked={autoBrowser} onChange={(e) => setAutoBrowser(e.target.checked)} /> Auto re-check in my browser
              </label>
              {!s.browserCheck?.running && networkBlockedIds.length > 0 && (
                <div className="dialog-actions"><button className="primary small" onClick={() => recheckBrowser(networkBlockedIds)}>Re-check now</button></div>
              )}
            </TrayItem>
          )}
          <MappingPanel s={s} onChange={changeMapping} />
          <RemovedPanel removed={s.removed} />
          <SuggestionsPanel
            suggestions={suggestions}
            busy={busyFields}
            onAdd={addFields}
            recheckHint={fieldsAdded}
            noDateCount={summary.okNoDate}
            onRecheckNoDate={() => { setFieldsAdded(false); recheck('nodate'); }}
          />
        </div>
      </div>

      <div className="workspace" ref={workspace} style={{ ['--split' as string]: `${split}%` }}>
        <section className="card-panel results-panel" aria-label="Audit results">
          <div className="panel-head">
            <h2>Audit results <span className="muted">({display.length.toLocaleString()} rows)</span></h2>
            <div className="tabbar" role="tablist">
              <button role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'tab active' : 'tab'} onClick={() => setTab('results')}>Table</button>
              <button role="tab" aria-selected={tab === 'cities'} className={tab === 'cities' ? 'tab active' : 'tab'} onClick={() => setTab('cities')}>By city</button>
            </div>
            <div className="spacer" />
            {s.filters.city && <button className="small" onClick={() => dispatch({ type: 'filters', patch: { city: null } })}>Clear city filter</button>}
            <input className="search" type="search" placeholder="Search city, state, URL, status, issue…" value={s.filters.text} onChange={(e) => dispatch({ type: 'filters', patch: { text: e.target.value } })} aria-label="Search results" />
          </div>
          {!hasRows ? (
            <div className="empty-state">
              <h2>Paste a Google Sheet link and press Sync</h2>
              <p>The tool reads every row, checks each ArcGIS endpoint, and shows the map’s date, the review date, the status and the reason for any failure.</p>
              <p className="muted">Share the sheet as “Anyone with the link can view”, or sign in with Google for a private one. Results are saved as they arrive, so closing the tab or restarting the server loses nothing.</p>
            </div>
          ) : tab === 'results' ? (
            <ResultsTable toolbar={<FilterBar rows={s.rows} results={s.results} filters={s.filters} onChange={(patch) => dispatch({ type: 'filters', patch })} shown={display.length} />} data={display} selectedId={s.selectedId} onSelect={select} onPatch={patchResult} freshnessCfg={s.config?.freshness} onOrder={setOrder} />
          ) : (
            <CityPanel rows={s.rows} results={s.results} selectedCity={s.filters.city} onPick={(key) => { dispatch({ type: 'filters', patch: { city: key, card: 'all' } }); if (key) setTab('results'); }} />
          )}
          <FreshnessLegend cfg={s.config?.freshness} />
        </section>

        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize table and map"
          aria-valuemin={25}
          aria-valuemax={70}
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          onPointerDown={dragSplit}
          onDoubleClick={() => moveSplit(48)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); moveSplit(split - 3); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); moveSplit(split + 3); }
          }}
        />

        <div className="right-col">
          <section className="card-panel map-panel" aria-label="Interactive map viewer">
            <div className="panel-head">
              <h2>Interactive map viewer</h2>
              {selected && <span className="muted small map-title">{selected.row.city}{selected.row.state ? `, ${selected.row.state}` : ''}</span>}
            </div>
            <div className="map-stage">
              {selected ? (
                <Suspense fallback={<p className="muted pad">Loading map…</p>}>
                  <MapViewer key={`${selected.row.id}|${selected.row.url}`} row={selected.row} result={selected.result} config={s.config} onRenderFailed={onRenderFailed} />
                </Suspense>
              ) : (
                <div className="map-empty">
                  <p>{hasRows ? 'Select a row to open its map here.' : 'The map of the selected row appears here.'}</p>
                  <p className="muted small">Use ← → or ↑ ↓ to move through the list.</p>
                </div>
              )}
            </div>
          </section>
          <div className="bottom-row">
            <DetailTabs item={selected} config={s.config} onPatch={(p) => s.selectedId && patchResult(s.selectedId, p)} />
            <PrimaryDateCard item={selected} config={s.config} index={navIndex} total={navIds.length} onPrev={() => step(-1)} onNext={() => step(1)} onMark={markReviewed} onRecheck={(id) => recheckBrowser([id])} rechecking={!!s.browserCheck?.running} />
          </div>
        </div>
      </div>
      {writeBackOpen && s.sheetKey && <WriteBackDialog sheetKey={s.sheetKey} dateFormat={dateFormat} onDateFormat={setDateFormat} onClose={() => setWriteBackOpen(false)} />}
      {previewOpen && s.sheet && <PreviewCopyDialog table={s.sheet.table} rows={s.rows} results={s.results} dateFormat={dateFormat} mapping={s.sheet.mapping} onDateFormat={setDateFormat} onClose={() => setPreviewOpen(false)} />}
    </div>
  );
}
