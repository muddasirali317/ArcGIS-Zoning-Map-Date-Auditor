import { useMemo, useRef, useState, type ReactNode } from 'react';
import { freshness, groupByCity, ISSUE_INFO, isFailure, type CheckResult, type CheckRow, type ColumnMapping, type DisplayRow, type Filters, type QueueStats, type RawConfig, type Summary, type SyncMode } from '@zoning/core';
import type { RemovedRow, State } from './store';
import { Logo } from './Logo';

// ---------------------------------------------------------------------------
// Brand + status header
// ---------------------------------------------------------------------------

export function BrandBar({ s, actions }: { s: State; actions: ReactNode }) {
  const state = s.stats?.state;
  const status =
    state === 'running' ? { t: 'RUNNING', cls: 'run' } :
    state === 'paused' ? { t: 'PAUSED', cls: 'warn' } :
    s.syncing ? { t: 'SYNCING', cls: 'run' } :
    s.rows.length ? { t: 'ACTIVE', cls: 'ok' } : { t: 'IDLE', cls: 'idle' };
  const today = new Date().toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' });
  return (
    <header className="brandbar">
      <div className="brand">
        <Logo size={30} className="brand-logo" />
        <h1>ArcGIS Zoning Map Date Auditor</h1>
      </div>
      <div className="statuscluster">
        <span className="stat"><span className="stat-k">Date</span><span className="stat-v">{today}</span></span>
        <span className="stat"><span className="stat-k">Target</span><span className="stat-v">{s.rows.length ? s.rows.length.toLocaleString() : '—'}</span></span>
        <span className={`statuspill ${status.cls}`}><span className="dot" aria-hidden="true" />{status.t}</span>
        <span className="vr" aria-hidden="true" />
        <div className="header-actions">{actions}</div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Command strip: sheet link, run controls
// ---------------------------------------------------------------------------

function formatEta(stats: QueueStats | null, startedAt: number | null): string {
  if (!stats || !startedAt || stats.completed < 3 || stats.state !== 'running') return '';
  const perItem = (Date.now() - startedAt) / stats.completed;
  const secs = Math.round((perItem * (stats.total - stats.completed)) / 1000);
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d={d} /></svg>
);
const ICON_PLAY = 'M8 5v14l11-7z';
const ICON_PAUSE = 'M6 5h4v14H6zM14 5h4v14h-4z';
const ICON_STOP = 'M6 6h12v12H6z';

export function SheetPanel(props: { s: State; active: boolean; onUrl(v: string): void; onSync(): void }) {
  const { s } = props;
  const c = s.syncCounts;
  const syncState = s.syncing ? { t: 'Syncing…', cls: 'run' } : s.lastSynced ? { t: 'Synced', cls: 'ok' } : { t: 'Not synced', cls: 'idle' };
  return (
    <section className="cmd-panel sheet-panel" aria-label="Google Sheet">
      <div className="cmd-title">
        <span>Google Sheet link</span>
        <span className={`sync-state ${syncState.cls}`}>{syncState.t}</span>
      </div>
      <form className="sheet-form" onSubmit={(e) => { e.preventDefault(); props.onSync(); }}>
        <label className="sr-only" htmlFor="sheet-url">Google Sheet link</label>
        <input id="sheet-url" type="url" placeholder="https://docs.google.com/spreadsheets/d/…  (shared as “Anyone with the link can view”)" value={s.sheetUrl} onChange={(e) => props.onUrl(e.target.value)} />
        <button type="submit" className="primary" disabled={s.syncing || !s.sheetUrl.trim() || props.active} title="Read the sheet again and check only new or changed rows">
          {s.syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </form>
      <div className="cmd-meta muted small">
        {s.lastSynced ? `Last sync ${new Date(s.lastSynced).toLocaleString()}` : 'Paste a link and press Sync'}
        {c ? ` · ${c.unchanged} unchanged · ${c.changed} changed · ${c.added} new · ${c.removed} removed` : ''}
      </div>
    </section>
  );
}

export function RunControls(props: {
  s: State;
  pendingCount: number;
  failedCount: number;
  onRecheck(mode: SyncMode): void;
  onControl(a: 'pause' | 'resume' | 'cancel'): void;
  onBrowserRecheck(): void;
}) {
  const { s } = props;
  const state = s.stats?.state;
  const running = state === 'running';
  const paused = state === 'paused';
  const active = running || paused;
  const menu = useRef<HTMLDetailsElement>(null);
  const close = (fn: () => void) => () => {
    fn();
    if (menu.current) menu.current.open = false;
  };
  const eta = formatEta(s.stats, s.startedAt);
  const canPlay = paused || (!active && s.rows.length > 0 && props.pendingCount > 0);
  const playTitle = paused ? 'Resume the run' : props.pendingCount > 0 ? `Check the ${props.pendingCount} pending map(s)` : 'Nothing pending';
  return (
    <section className="cmd-panel run-panel" aria-label="Run controls">
      <div className="cmd-title"><span>Run controls</span></div>
      <div className="run-buttons">
        <button className="icon-btn go" aria-label={paused ? 'Resume' : 'Run pending'} title={playTitle} disabled={!canPlay} onClick={() => (paused ? props.onControl('resume') : props.onRecheck('changed'))}><Icon d={ICON_PLAY} /></button>
        <button className="icon-btn" aria-label="Pause" title="Pause the run" disabled={!running} onClick={() => props.onControl('pause')}><Icon d={ICON_PAUSE} /></button>
        <button className="icon-btn stop" aria-label="Cancel run" title="Cancel the run" disabled={!active} onClick={() => props.onControl('cancel')}><Icon d={ICON_STOP} /></button>
        <details className="menu run-more" ref={menu}>
          <summary className="button small" aria-label="More run options">More ▾</summary>
          <div className="menu-pop" role="menu">
            <button role="menuitem" disabled={active || s.rows.length === 0} onClick={close(() => props.onRecheck('failed'))}>Re-check failed <span className="muted small">+ pending</span></button>
            <button role="menuitem" disabled={active || s.rows.length === 0} onClick={close(() => props.onRecheck('all'))}>Re-check all <span className="muted small">ignore cache</span></button>
            <button role="menuitem" disabled={props.failedCount === 0 || !!s.browserCheck?.running || !s.config} onClick={close(props.onBrowserRecheck)} title="Runs the check from this browser instead of the server. Turn your browser VPN on first.">
              {s.browserCheck?.running ? `Browser… ${s.browserCheck.done}/${s.browserCheck.total}` : `Re-check ${props.failedCount} failed in browser`} <span className="muted small">VPN</span>
            </button>
          </div>
        </details>
      </div>
      <div className="cmd-meta muted small" aria-live="polite">
        {s.stats ? `${s.stats.completed}/${s.stats.total} this run · ${state}` : 'No run in progress'}{eta ? ` · ETA ${eta}` : ''}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// KPI tiles and the issue strip
// ---------------------------------------------------------------------------

const CARDS: { key: Filters['card']; label: string; value: (s: Summary) => number; hint: string }[] = [
  { key: 'all', label: 'Total maps', value: (s) => s.total, hint: 'Every link from the sheet' },
  { key: 'checked', label: 'Checked', value: (s) => s.checked, hint: 'Finished (passed, no date, or issue)' },
  { key: 'passed', label: 'OK', value: (s) => s.passed, hint: 'Loaded and a date was found' },
  { key: 'nodate', label: 'OK no date', value: (s) => s.okNoDate, hint: 'Loaded, but no date anywhere' },
  { key: 'issues', label: 'Issues', value: (s) => s.issues, hint: 'Did not load; see the reason' },
  { key: 'pending', label: 'Pending', value: (s) => s.pending, hint: 'Not checked yet' },
];

export function SummaryCards(props: { summary: Summary; active: Filters['card']; onPick(c: Filters['card']): void }) {
  const s = props.summary;
  return (
    <div className="cards" role="group" aria-label="Summary">
      {CARDS.map((c) => {
        const val = c.value(s);
        const pct = c.key === 'checked' && s.total ? Math.round((s.checked / s.total) * 100) : null;
        return (
          <button key={c.key} className={`card ${props.active === c.key && c.key !== 'all' ? 'active' : ''} card-${c.key}`} onClick={() => props.onPick(props.active === c.key ? 'all' : c.key)} aria-pressed={props.active === c.key && c.key !== 'all'} title={`${c.hint}. Click to filter the table.`}>
            <span className="card-label">{c.label}</span>
            <span className="card-value">{val.toLocaleString()}</span>
            {pct !== null && (
              <span className="card-meter" role="img" aria-label={`${pct}% checked`}>
                <span className="card-meter-fill" style={{ width: `${pct}%` }} />
                <span className="card-sub">{pct}%</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function IssueSummary({ results }: { results: Record<string, CheckResult> }) {
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of Object.values(results)) m[r.status] = (m[r.status] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [results]);
  if (counts.length === 0) return null;
  const checked = counts.reduce((n, [, c]) => n + c, 0);
  const cls = (code: string) => (code === 'OK' ? 'ok' : code === 'OK_NO_DATE' ? 'warn' : isFailure(code as CheckResult['status']) ? 'fail' : 'pending');
  return (
    <div className="issue-summary">
      <span className="issue-summary-label">Summary by issue <span className="muted">({checked.toLocaleString()} checked)</span></span>
      <div className="issue-chips">
        {counts.map(([code, n]) => <span key={code} className={`issue-chip ${cls(code)}`}>{code}: {n}</span>)}
      </div>
    </div>
  );
}

export function FreshnessLegend({ cfg }: { cfg: RawConfig['freshness'] | undefined }) {
  const t = cfg ?? { greenYears: 1, yellowYears: 3, orangeYears: 5 };
  const now = new Date();
  const sample = (years: number) => new Date(now.getTime() - years * 365.25 * 86400_000).toISOString().slice(0, 10);
  const items = [
    ['green', `≤ ${t.greenYears} yr`, sample(t.greenYears / 2)],
    ['yellow', `${t.greenYears}–${t.yellowYears} yr`, sample((t.greenYears + t.yellowYears) / 2)],
    ['orange', `${t.yellowYears}–${t.orangeYears} yr`, sample((t.yellowYears + t.orangeYears) / 2)],
    ['red', `> ${t.orangeYears} yr`, sample(t.orangeYears + 1)],
    ['grey', 'No date', 'None'],
  ] as const;
  return (
    <div className="fresh-legend" aria-label="Date freshness legend">
      <span className="muted small">Date age:</span>
      {items.map(([level, text, date]) => (
        <span key={level} className={`chip ${freshness(date, t).level}`}>{text}</span>
      ))}
      <span className="chip fail-outline">Red outline: failed to load</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tray: secondary panels (column mapping, removed rows, field suggestions) shown as compact pills
// that open a popover, so they never push the table and map down the page.
// ---------------------------------------------------------------------------

export function TrayItem(props: { summary: ReactNode; className?: string; attention?: boolean; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className={`tray-item ${props.className ?? ''} ${props.attention ? 'attention' : ''}`} open={props.defaultOpen}>
      <summary>{props.summary}</summary>
      <div className="tray-pop">{props.children}</div>
    </details>
  );
}

const FIELDS: [keyof ColumnMapping, string][] = [
  ['city', 'City / Municipality'],
  ['state', 'State'],
  ['county', 'County'],
  ['url', 'Map URL'],
  ['altUrl', 'Fallback link (used only when Map URL has none)'],
];

export function MappingPanel(props: { s: State; onChange(m: ColumnMapping): void }) {
  const { sheet, cleaning, rows } = props.s;
  if (!sheet) return null;
  const headers = sheet.table[0];
  const missingUrl = sheet.mapping.url === null;
  return (
    <TrayItem
      className="mapping"
      attention={missingUrl}
      defaultOpen={missingUrl}
      summary={<>Columns · {rows.length} link(s) from {sheet.table.length - 1} row(s){cleaning && cleaning.duplicates ? ` · ${cleaning.duplicates} duplicate` : ''}</>}
    >
      {cleaning && <p className="muted small">{cleaning.blankDropped} blank dropped · {cleaning.split} extra link(s) split out · {cleaning.duplicates} duplicate-flagged</p>}
      {missingUrl && (
        <p className="warn-text" role="alert">
          No column with map links was found. Pick the Map URL column below, or check that the sheet link points at the right tab (the number after <code>gid=</code>).
        </p>
      )}
      <div className="mapping-grid">
        {FIELDS.map(([key, label]) => (
          <label key={key}>
            {label}
            <select value={sheet.mapping[key] ?? ''} onChange={(e) => props.onChange({ ...sheet.mapping, [key]: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">(none)</option>
              {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>
          </label>
        ))}
      </div>
      <p className="muted small">Your choice is remembered for this sheet. Rows whose City, State and link did not change keep their stored result. The fallback column is optional: a viewer link there is resolved to its map when the Map URL cell is empty.</p>
    </TrayItem>
  );
}

export function RemovedPanel({ removed }: { removed: RemovedRow[] }) {
  if (removed.length === 0) return null;
  return (
    <TrayItem className="removed" summary={<>{removed.length} row(s) removed from the sheet</>}>
      <p className="muted small">Marked removed; their results are kept.</p>
      <ul className="plain small">
        {removed.map(({ row, result }) => (
          <li key={row.fingerprint}>
            <span className="badge pending">REMOVED</span> {row.city}{row.state ? `, ${row.state}` : ''} · {row.url || '(no link)'} · last status {result?.status ?? 'never checked'}{result ? ` · date ${result.primaryDate}` : ''}
          </li>
        ))}
      </ul>
    </TrayItem>
  );
}

// ---------------------------------------------------------------------------
// City issue panel
// ---------------------------------------------------------------------------

export function CityPanel(props: { rows: CheckRow[]; results: Record<string, CheckResult>; selectedCity: string | null; onPick(key: string | null): void }) {
  const [sort, setSort] = useState<'issues' | 'name'>('issues');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const g = groupByCity(props.rows, props.results);
    return sort === 'name' ? [...g].sort((a, b) => a.city.localeCompare(b.city)) : g;
  }, [props.rows, props.results, sort]);

  return (
    <section className="city-panel" aria-label="Issues by city">
      <div className="row sub">
        <strong>{groups.length} cities</strong>
        <div className="spacer" />
        <label className="inline">Sort by{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as 'issues' | 'name')}>
            <option value="issues">Most issues</option>
            <option value="name">City name</option>
          </select>
        </label>
      </div>
      <ul className="city-list">
        {groups.map((g) => {
          const isOpen = open.has(g.key);
          return (
            <li key={g.key} className={props.selectedCity === g.key ? 'selected' : ''}>
              <div className="city-head">
                <button className="link" onClick={() => setOpen((o) => { const n = new Set(o); isOpen ? n.delete(g.key) : n.add(g.key); return n; })} aria-expanded={isOpen}>
                  {isOpen ? '▾' : '▸'} {g.city}{g.state ? `, ${g.state}` : ''}
                </button>
                <span className="muted">{g.maps} map(s) · {g.checked} checked · </span>
                <span className={g.issues ? 'bad' : 'muted'}>{g.issues} issue(s)</span>
                <button className="small" onClick={() => props.onPick(props.selectedCity === g.key ? null : g.key)}>{props.selectedCity === g.key ? 'Clear filter' : 'Show maps'}</button>
              </div>
              {isOpen && (
                <ul className="issue-list">
                  {g.issueList.length === 0 && <li className="muted">{g.checked ? 'No issues.' : 'Not checked yet.'}</li>}
                  {g.issueList.map((i, n) => (
                    <li key={n}>
                      <code className={isFailure(i.code) ? 'code bad' : 'code'}>{i.code}</code> <span className="muted">row {i.rowId}</span> {i.reason}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Primary date card + review flow (one-by-one)
// ---------------------------------------------------------------------------

const badgeClass = (r: CheckResult) => (isFailure(r.status) ? 'fail' : r.status === 'OK' ? 'ok' : 'warn');

export function PrimaryDateCard(props: {
  item: DisplayRow | null;
  config: State['config'];
  index: number;
  total: number;
  onPrev(): void;
  onNext(): void;
  onMark(advance: boolean): void;
  onRecheck(id: string): void;
  rechecking: boolean;
}) {
  const { item, config, index, total } = props;
  const r = item?.result;
  const fresh = r ? freshness(r.primaryDate, config?.freshness) : null;
  const hasSelection = index >= 0;
  return (
    <section className="primary-card" aria-label="Primary date">
      <div className="cmd-title">
        <span>Primary date</span>
        <span className="review-nav">
          <button className="icon-btn sm" onClick={props.onPrev} disabled={!hasSelection || index <= 0} aria-label="Previous map (left arrow)" title="Previous map (←)">‹</button>
          <span className="muted small" aria-live="polite">{hasSelection ? `${index + 1} / ${total}` : `${total} rows`}</span>
          <button className="icon-btn sm" onClick={props.onNext} disabled={total === 0 || index >= total - 1} aria-label="Next map (right arrow)" title="Next map (→)">›</button>
        </span>
      </div>
      {!item ? (
        <p className="muted pc-empty">Select a row to see its date, the source of that date and the review controls. Arrow keys move through the list.</p>
      ) : !r ? (
        <>
          <p className="pc-city">{item.row.city || '(no city)'}{item.row.state ? `, ${item.row.state}` : ''}</p>
          <p className="muted pc-empty">Not checked yet.</p>
        </>
      ) : (
        <>
          <p className="pc-city" title={item.row.url}>{item.row.city || '(no city)'}{item.row.state ? `, ${item.row.state}` : ''} <span className={`badge ${badgeClass(r)}`}>{r.status}</span></p>
          <div className="pc-date">
            <span className="pc-date-value">{r.primaryDate}</span>
            {fresh && <span className={`chip ${fresh.level}`}>{fresh.label}</span>}
          </div>
          <dl className="pc-facts">
            <dt>Source</dt><dd title={r.dateSource}>{r.dateSource} <span className="muted">· {r.dateConfidence}</span></dd>
            <dt>Review</dt><dd>{r.reviewDate}{r.manualReview ? ' ✓ by you' : ''}</dd>
          </dl>
          <div className="pc-actions">
            <button className="primary" onClick={() => props.onMark(false)} title="Stamp today's date as the review date after looking at the map">{r.manualReview ? 'Reviewed ✓' : 'Mark reviewed'}</button>
            <button onClick={() => props.onMark(true)} title="Mark reviewed, then open the next map">Mark &amp; next</button>
            <button className="small" onClick={() => props.onRecheck(item.row.id)} disabled={props.rechecking || !config} title="Check this map from your browser (use with the browser VPN on)">Re-check in browser</button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail tabs: layers, all dates, issues, analyst
// ---------------------------------------------------------------------------

type DetailTab = 'layers' | 'dates' | 'issues' | 'analyst';

export function DetailTabs(props: {
  item: DisplayRow | null;
  config: State['config'];
  onPatch(p: { reviewer?: string; analystNote?: string }): void;
}) {
  const [tab, setTab] = useState<DetailTab>('layers');
  const { item } = props;
  const r = item?.result;
  const issueCount = r?.issues.length ?? 0;
  const failed = !!r && isFailure(r.status);
  const tabs: [DetailTab, string][] = [
    ['layers', `Layers${r ? ` (${r.layers.length})` : ''}`],
    ['dates', `All dates${r ? ` (${r.allDates.length})` : ''}`],
    ['issues', `Issues${r ? ` (${issueCount})` : ''}`],
    ['analyst', 'Analyst'],
  ];
  return (
    <section className="detail-tabs" aria-label="Map details">
      <div className="tabbar" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''} ${k === 'issues' && failed ? 'alert' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div className="detail-body" role="tabpanel">
        {!item ? (
          <p className="muted">Select a row to see every date found, the evidence behind it, and the layer details.</p>
        ) : !r ? (
          <p className="muted">Not checked yet.</p>
        ) : tab === 'layers' ? (
          <LayersTab r={r} />
        ) : tab === 'dates' ? (
          <DatesTab r={r} />
        ) : tab === 'issues' ? (
          <IssuesTab r={r} row={item.row} />
        ) : (
          <div className="analyst">
            <label className="stack">Reviewer<input value={r.reviewer} onChange={(e) => props.onPatch({ reviewer: e.target.value })} /></label>
            <label className="stack">Note<textarea rows={3} value={r.analystNote} onChange={(e) => props.onPatch({ analystNote: e.target.value })} /></label>
          </div>
        )}
      </div>
    </section>
  );
}

function LayersTab({ r }: { r: CheckResult }) {
  if (r.layers.length === 0) return <p className="muted">No layers were read.</p>;
  return (
    <table className="mini">
      <thead><tr><th>Layer</th><th>Date fields used</th><th>Result</th></tr></thead>
      <tbody>
        {r.layers.map((l) => (
          <tr key={l.id}>
            <td>{l.name}<div className="muted small">#{l.id}{l.zoningScore ? ' · zoning-like' : ''}</div></td>
            <td>{l.matchedFields.join(', ') || '—'}</td>
            <td>
              {l.error ? <span className="bad">{l.error}</span> : l.dates.filter((d) => d.role !== 'min').map((d) => d.date).join(', ') || 'no date'}
              {l.note && <div className="muted small">{l.note}</div>}
              {Object.entries(l.nonNullCounts).map(([f, n]) => <div key={f} className="muted small">{f}: {n} non-null</div>)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DatesTab({ r }: { r: CheckResult }) {
  return (
    <>
      {r.allDates.length === 0 ? <p className="muted">No dates were found.</p> : (
        <table className="mini">
          <thead><tr><th>Date</th><th>Source</th><th>Kind</th><th>Layer</th><th></th></tr></thead>
          <tbody>
            {r.allDates.map((d, n) => (
              <tr key={n} className={d.future ? 'future' : ''}>
                <td>{d.date}{d.future ? ' (future)' : ''}</td>
                <td>{d.source}</td>
                <td>{d.role}{d.primaryEligible ? '' : ' · not used'}</td>
                <td>{d.layer ?? ''}</td>
                <td><a href={d.evidenceUrl} target="_blank" rel="noreferrer">evidence</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.otherDateFields.length > 0 && (
        <p className="muted small">Other date fields found ({r.otherDateFields.length}): {r.otherDateFields.join(', ')}. If one is a real “last updated” field, add its name to <code>config/config.json</code>.</p>
      )}
    </>
  );
}

function IssuesTab({ r, row }: { r: CheckResult; row: CheckRow }) {
  return (
    <>
      <dl className="facts">
        <dt>Link</dt><dd className="break small"><a href={row.url} target="_blank" rel="noreferrer">{row.url || '(empty)'}</a></dd>
        {r.resolvedFrom && (<><dt>Resolved from</dt><dd className="break small">{r.resolvedFrom}</dd></>)}
        {row.fallback && (<><dt>Link taken from</dt><dd>the fallback column</dd></>)}
        {r.itemModifiedDate !== 'None' && (<><dt>Portal item date</dt><dd>{r.itemModifiedDate} <span className="muted small">low confidence</span></dd></>)}
        <dt>Requests</dt><dd>{r.responseTimeMs} ms · {r.retries} retr{r.retries === 1 ? 'y' : 'ies'}{r.fromCache ? ' · 24 h cache' : ''} · {r.via}</dd>
        {r.zoningLayerName && (<><dt>Zoning layer</dt><dd>{r.zoningLayerName}</dd></>)}
      </dl>
      <div className="actions">
        {r.normalizedUrl && <a className="button small" href={r.normalizedUrl} target="_blank" rel="noreferrer">Open endpoint</a>}
        {r.evidenceUrl && <a className="button small" href={r.evidenceUrl} target="_blank" rel="noreferrer">Open evidence request</a>}
      </div>
      {r.issues.length === 0 ? <p className="muted">No issues.</p> : (
        <ul className="plain">
          {r.issues.map((i, n) => (
            <li key={n}><code className={isFailure(i.code) ? 'code bad' : 'code'}>{i.code}</code> {i.reason}<div className="muted small">Suggested action: {ISSUE_INFO[i.code].action}</div></li>
          ))}
        </ul>
      )}
    </>
  );
}
