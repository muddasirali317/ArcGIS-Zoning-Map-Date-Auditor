import { useEffect, useMemo, useRef, useState } from 'react';
import { buildCopyTable, COPY_COLUMNS, type ColumnMapping, type CheckResult, type CheckRow, type DateFormat, type FieldSuggestion } from '@zoning/core';
import { ApiError, writeBack, type AuthStatus, type WriteBackSummary } from './api';
import { TrayItem } from './components';
import type { ThemeChoice } from './store';

/** A1-style column letter for a 0-based index (0 -> A, 26 -> AA). */
function columnLetter(n: number): string {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---------------------------------------------------------------------------
// Export menu
// ---------------------------------------------------------------------------

export function ExportMenu(props: { checked: number; issues: number; hasSheet: boolean; dateFormat: DateFormat; onDateFormat(f: DateFormat): void; onFull(): void; onIssues(): void; onSheetReady(): void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const run = (fn: () => void) => () => {
    fn();
    if (ref.current) ref.current.open = false;
  };
  return (
    <details className="menu" ref={ref}>
      <summary className="button primary" aria-label="Download CSV">Download CSV ▾</summary>
      <div className="menu-pop" role="menu">
        <button role="menuitem" onClick={run(props.onFull)} disabled={props.checked === 0}>
          Full CSV <span className="muted small">all {props.checked} checked, summary columns</span>
        </button>
        <button role="menuitem" onClick={run(props.onIssues)} disabled={props.issues === 0}>
          Issues only <span className="muted small">{props.issues} map(s) that did not load, with reasons</span>
        </button>
        <button role="menuitem" onClick={run(props.onSheetReady)} disabled={props.checked === 0 || !props.hasSheet} title={props.hasSheet ? '' : 'Sync once so the tool has your sheet'}>
          Sheet-ready <span className="muted small">your sheet + Primary Date, Updation Status, Last Reviewed, Map Issues</span>
        </button>
        <label className="menu-opt">
          Dates in Sheet-ready as{' '}
          <select value={props.dateFormat} onChange={(e) => props.onDateFormat(e.target.value as DateFormat)}>
            <option value="iso">YYYY-MM-DD</option>
            <option value="dmy">DD-MM-YYYY</option>
          </select>
        </label>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Google account bar
// ---------------------------------------------------------------------------

export function GoogleBar(props: {
  auth: AuthStatus | null;
  needsSignIn: { canSignIn: boolean } | null;
  waiting: boolean;
  hasSheet: boolean;
  onSignIn(write: boolean): void;
  onSignOut(): void;
  onWriteBack(): void;
}) {
  const { auth } = props;
  if (!auth) return null;
  if (!auth.configured && !props.needsSignIn) return null; // nothing to offer, and nothing is blocked
  return (
    <div className={`google-bar ${props.needsSignIn ? 'attention' : ''}`} role={props.needsSignIn ? 'alert' : undefined}>
      {props.needsSignIn && (
        <span>
          This sheet is private.{' '}
          {props.needsSignIn.canSignIn
            ? 'Sign in with Google to read it, then press Sync again.'
            : 'Share it as “Anyone with the link can view”, or set up Google sign-in (see the README: GOOGLE_CLIENT_ID).'}
        </span>
      )}
      {auth.configured && (
        <>
          <span className="muted small">Google: {auth.signedIn ? (auth.canWrite ? 'signed in, can edit sheets' : 'signed in, read-only') : 'not signed in'}</span>
          {!auth.signedIn && <button className="small" onClick={() => props.onSignIn(false)} disabled={props.waiting}>{props.waiting ? 'Waiting for Google…' : 'Sign in with Google'}</button>}
          {auth.signedIn && !auth.canWrite && <button className="small" onClick={() => props.onSignIn(true)} disabled={props.waiting}>{props.waiting ? 'Waiting for Google…' : 'Enable write-back'}</button>}
          {auth.signedIn && auth.canWrite && <button className="small" onClick={props.onWriteBack} disabled={!props.hasSheet}>Write results to the sheet…</button>}
          {auth.signedIn && <button className="small" onClick={props.onSignOut}>Sign out</button>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Write-back confirmation
// ---------------------------------------------------------------------------

export function WriteBackDialog(props: { sheetKey: string; dateFormat: DateFormat; onDateFormat(f: DateFormat): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [summary, setSummary] = useState<WriteBackSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [done, setDone] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

  // Ask the server what it would write (it also checks that the sheet has not changed since the last Sync).
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    writeBack(props.sheetKey, false, props.dateFormat)
      .then((r) => live && setSummary(r.summary))
      .catch((e) => live && (setSummary(null), setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [props.sheetKey, props.dateFormat]);

  const write = async () => {
    setBusy(true);
    setError('');
    try {
      await writeBack(props.sheetKey, true, props.dateFormat);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={props.onClose} aria-labelledby="wb-title">
      <h2 id="wb-title">Write results to the Google Sheet</h2>
      {done ? (
        <p>Done. The Primary Date, Updation Status and Map Issues columns are in your sheet. Your own columns (New date included) were not touched.</p>
      ) : (
        <>
          {busy && !summary && !error && <p className="muted">Checking the sheet…</p>}
          {summary && (
            <>
              <p>
                This will write <strong>{summary.columns.length} columns</strong> for <strong>{summary.rows} rows</strong> ({summary.checked} checked so far) into the tab you synced. Only these columns are touched:
              </p>
              <ul className="plain small">{summary.columns.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
              {summary.replacesExisting.length > 0 && (
                <p className="warn-text" role="alert">These columns already exist in your sheet and their contents will be replaced: {summary.replacesExisting.join(', ')}.</p>
              )}
              <label className="stack">Write dates as
                <select value={props.dateFormat} onChange={(e) => props.onDateFormat(e.target.value as DateFormat)}>
                  <option value="iso">YYYY-MM-DD</option>
                  <option value="dmy">DD-MM-YYYY</option>
                </select>
              </label>
              <p className="muted small">Values are written as plain text. The sheet was just re-read and still matches your last Sync.</p>
            </>
          )}
        </>
      )}
      {error && <p className="bad" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button onClick={props.onClose}>{done ? 'Close' : 'Cancel'}</button>
        {!done && <button className="primary" onClick={write} disabled={busy || !summary}>{busy && summary ? 'Writing…' : 'Write to sheet'}</button>}
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Preview the sheet changes and copy them to paste (no Google sign-in needed)
// ---------------------------------------------------------------------------

export function PreviewCopyDialog(props: {
  table: string[][];
  rows: CheckRow[];
  results: Record<string, CheckResult>;
  dateFormat: DateFormat;
  mapping: ColumnMapping;
  onDateFormat(f: DateFormat): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);

  const { data, tsv } = useMemo(() => {
    const data = buildCopyTable(props.table, props.rows, props.results, props.mapping, props.dateFormat);
    const clean = (v: string) => (v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
    return { data, tsv: data.map((row) => row.map(clean).join('\t')).join('\n') };
  }, [props.table, props.rows, props.results, props.mapping, props.dateFormat]);

  const preview = data.slice(1).filter((r) => r.some(Boolean)).slice(0, 60);
  const total = data.slice(1).filter((r) => r.some(Boolean)).length;

  const copy = async () => {
    try { await navigator.clipboard.writeText(tsv); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch { taRef.current?.focus(); taRef.current?.select(); }
  };

  return (
    <dialog ref={ref} className="dialog wide" onClose={props.onClose} aria-labelledby="pc-title">
      <h2 id="pc-title">Review, then copy</h2>
      <p className="muted small">
        Only these {COPY_COLUMNS.length} columns are copied: {COPY_COLUMNS.join(', ')}. Nothing is sent to Google. Click <strong>Copy</strong>, then paste (Ctrl+V) into cell A1 of any sheet.
      </p>
      <label className="stack">Dates as
        <select value={props.dateFormat} onChange={(e) => props.onDateFormat(e.target.value as DateFormat)}>
          <option value="dmy">DD-MM-YYYY (matches your sheet)</option>
          <option value="iso">YYYY-MM-DD</option>
        </select>
      </label>
      <div className="preview-scroll" style={{ maxHeight: '45vh', overflow: 'auto', margin: '0.5rem 0' }}>
        <table className="mini">
          <thead><tr>{COPY_COLUMNS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {preview.map((r, i) => <tr key={i}>{r.map((v, k) => <td key={k}>{v}</td>)}</tr>)}
          </tbody>
        </table>
        {total > preview.length && <p className="muted small">+{total - preview.length} more rows (all are included when you copy).</p>}
      </div>
      <textarea ref={taRef} readOnly value={tsv} aria-label="Data to paste" style={{ width: '100%', height: '3rem', fontFamily: 'monospace', fontSize: '0.75rem' }} />
      <div className="dialog-actions">
        <button onClick={props.onClose}>Close</button>
        <button className="primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Suggested date-field names
// ---------------------------------------------------------------------------

export function SuggestionsPanel(props: {
  suggestions: FieldSuggestion[];
  busy: boolean;
  onAdd(names: string[]): void;
  /** Shown after names were added: re-check the maps that loaded without a date. */
  recheckHint: boolean;
  noDateCount: number;
  onRecheckNoDate(): void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  if (props.suggestions.length === 0 && !props.recheckHint) return null;
  const toggle = (n: string) => setPicked((p) => { const x = new Set(p); x.has(n) ? x.delete(n) : x.add(n); return x; });
  return (
    <TrayItem
      className="suggestions"
      summary={<>
        {props.suggestions.length} date field name(s) not on the list
        {props.suggestions.some((s) => s.likelihood === 'likely') ? ` · ${props.suggestions.filter((s) => s.likelihood === 'likely').length} look like “last updated”` : ''}
      </>}
    >
      {props.recheckHint && (
        <p className="ok-text" role="status">
          Added. {props.noDateCount} map(s) loaded without a date.{' '}
          <button className="small primary" onClick={props.onRecheckNoDate} disabled={props.noDateCount === 0}>Re-check those maps</button>
        </p>
      )}
      <p className="muted small">These date fields exist on the maps but their names are not in <code>config/config.json</code>, so they were ignored. Adding a name makes the tool read it. Review each: “created” style fields are not a map’s update date.</p>
      <table className="mini">
        <thead><tr><th></th><th>Field name</th><th>Looks like</th><th>Maps</th><th>Maps with no date</th><th>Examples</th></tr></thead>
        <tbody>
          {props.suggestions.map((s) => (
            <tr key={s.name}>
              <td><input type="checkbox" aria-label={`Add ${s.name}`} checked={picked.has(s.name)} onChange={() => toggle(s.name)} /></td>
              <td><code>{s.name}</code></td>
              <td><span className={`badge ${s.likelihood === 'likely' ? 'ok' : s.likelihood === 'unlikely' ? 'pending' : 'warn'}`}>{s.likelihood === 'likely' ? 'update date' : s.likelihood === 'unlikely' ? 'not an update date' : 'unsure'}</span></td>
              <td>{s.maps}</td>
              <td>{s.mapsWithoutDate}</td>
              <td className="muted small">{s.examples.join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row sub">
        <button className="primary small" disabled={picked.size === 0 || props.busy} onClick={() => { props.onAdd([...picked]); setPicked(new Set()); }}>
          Add {picked.size || ''} selected to the config
        </button>
        <button className="small" onClick={() => setPicked(new Set(props.suggestions.filter((s) => s.likelihood === 'likely').map((s) => s.name)))}>Select the likely ones</button>
      </div>
    </TrayItem>
  );
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemeChoice, string> = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' };

export function ThemeToggle({ theme, onChange }: { theme: ThemeChoice; onChange(t: ThemeChoice): void }) {
  return (
    <button className="small theme-btn" onClick={() => onChange(NEXT[theme])} title="Switch between matching the system, light and dark">
      {LABEL[theme]}
    </button>
  );
}
