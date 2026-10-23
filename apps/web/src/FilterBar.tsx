import { isFiltered, NO_FILTERS, type CheckResult, type CheckRow, type Filters } from '@zoning/core';

/** One compact row: the common filters inline, the rarer ones in a popover, so the table keeps its height. */
export function FilterBar(props: { rows: CheckRow[]; results: Record<string, CheckResult>; filters: Filters; onChange(p: Partial<Filters>): void; shown: number }) {
  const { filters: f } = props;
  const results = Object.values(props.results);
  const statuses = [...new Set(results.map((r) => r.status))].sort();
  const codes = [...new Set(results.flatMap((r) => r.issues.map((i) => i.code)))].sort();
  const states = [...new Set(props.rows.map((r) => r.state).filter(Boolean))].sort();
  const moreActive = Boolean(f.dateFrom || f.dateTo || f.olderThanYears || f.noDate || f.code);
  return (
    <div className="filter-bar" role="search" aria-label="Filters">
      <span className="muted small">Filters</span>
      <select aria-label="Status" value={f.status} onChange={(e) => props.onChange({ status: e.target.value })}>
        <option value="">Status: any</option>
        <option value="PENDING">PENDING</option>
        {statuses.map((s) => <option key={s}>{s}</option>)}
      </select>
      <select aria-label="State" value={f.state} onChange={(e) => props.onChange({ state: e.target.value })}>
        <option value="">State: any</option>
        {states.map((s) => <option key={s}>{s}</option>)}
      </select>
      <details className="menu more-filters">
        <summary className={`button small ${moreActive ? 'on' : ''}`}>Date &amp; more{moreActive ? ' •' : ''} ▾</summary>
        <div className="menu-pop filter-pop">
          <label>Issue code
            <select value={f.code} onChange={(e) => props.onChange({ code: e.target.value })}>
              <option value="">Any</option>
              {codes.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label>Date from<input type="date" value={f.dateFrom} onChange={(e) => props.onChange({ dateFrom: e.target.value })} /></label>
          <label>Date to<input type="date" value={f.dateTo} onChange={(e) => props.onChange({ dateTo: e.target.value })} /></label>
          <label>Older than (years)
            <input type="number" min={0} step={0.5} value={f.olderThanYears ?? ''} onChange={(e) => props.onChange({ olderThanYears: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label className="check"><input type="checkbox" checked={f.noDate} onChange={(e) => props.onChange({ noDate: e.target.checked })} /> No date only</label>
        </div>
      </details>
      <div className="spacer" />
      {isFiltered(f) && <button className="small" onClick={() => props.onChange({ ...NO_FILTERS })}>Clear filters</button>}
      <span className="muted small">{props.shown.toLocaleString()} of {props.rows.length.toLocaleString()}</span>
    </div>
  );
}
