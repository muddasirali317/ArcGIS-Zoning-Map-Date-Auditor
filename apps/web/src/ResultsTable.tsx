import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState, type VisibilityState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { freshness, isFailure, type DisplayRow, type RawConfig } from '@zoning/core';

const ROW_HEIGHT = 40;
const col = createColumnHelper<DisplayRow>();

const statusClass = (d: DisplayRow) => (!d.result ? 'pending' : isFailure(d.result.status) ? 'fail' : d.result.status === 'OK' ? 'ok' : 'warn');

export function ResultsTable(props: {
  data: DisplayRow[];
  selectedId: string | null;
  onSelect(id: string): void;
  onPatch(id: string, p: { reviewer?: string; analystNote?: string }): void;
  freshnessCfg: RawConfig['freshness'] | undefined;
  /** Reports the row order as shown (after sorting) so Previous / Next follow what the analyst sees. */
  onOrder(ids: string[]): void;
  /** Rendered at the left of the toolbar row (the filters), next to the Columns menu. */
  toolbar?: ReactNode;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ reviewer: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const { onPatch, freshnessCfg } = props;

  const columns = useMemo(
    () => [
      col.accessor((d) => d.row.sheetRow, { id: 'row', header: 'Row', size: 48, cell: (c) => c.row.original.row.id }),
      col.accessor((d) => d.row.city, { id: 'city', header: 'City', size: 120 }),
      col.accessor((d) => d.row.state, { id: 'state', header: 'State', size: 54 }),
      col.accessor((d) => d.row.url, {
        id: 'url',
        header: 'Map URL',
        size: 190,
        enableSorting: false,
        cell: (c) => (
          <a href={c.getValue()} target="_blank" rel="noreferrer" title={c.getValue()} onClick={(e) => e.stopPropagation()}>{c.getValue() || '(empty)'}</a>
        ),
      }),
      col.accessor((d) => d.result?.status ?? 'zz', {
        id: 'status',
        header: 'Status',
        size: 140,
        cell: (c) => <span className={`badge ${statusClass(c.row.original)}`}>{c.row.original.result?.status ?? 'PENDING'}</span>,
      }),
      // Rows without a date (pending, failed, or None) sort last in both directions.
      col.accessor((d) => (d.result && d.result.primaryDate !== 'None' ? d.result.primaryDate : undefined), {
        id: 'date',
        header: 'Primary Date',
        size: 160,
        sortUndefined: 'last',
        cell: (c) => {
          const r = c.row.original.result;
          if (!r) return <span className="muted">—</span>;
          const f = freshness(r.primaryDate, freshnessCfg);
          return <span className={`chip ${f.level}`}>{r.primaryDate}{f.level !== 'grey' && <small>{f.label}</small>}</span>;
        },
      }),
      col.accessor((d) => d.result?.dateSource ?? '', { id: 'source', header: 'Date Source', size: 170, cell: (c) => <span title={c.getValue()}>{c.getValue()}</span> }),
      col.accessor((d) => d.result?.reviewDate ?? '', {
        id: 'review',
        header: 'Review Date',
        size: 108,
        cell: (c) => <span title={c.row.original.result?.manualReview ? 'Marked reviewed by you' : 'Date of the automatic check'}>{c.getValue()}{c.row.original.result?.manualReview ? ' ✓' : ''}</span>,
      }),
      col.display({
        id: 'reviewer',
        header: 'Reviewer',
        size: 110,
        cell: (c) => {
          const d = c.row.original;
          return (
            <input className="cell-input" aria-label={`Reviewer for row ${d.row.id}`} value={d.result?.reviewer ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => onPatch(d.row.id, { reviewer: e.target.value })} disabled={!d.result} />
          );
        },
      }),
      col.accessor((d) => d.result?.issueReason ?? '', { id: 'issue', header: 'Issue', size: 300, enableSorting: false, cell: (c) => <span title={c.getValue()}>{c.getValue()}</span> }),
      col.display({
        id: 'note',
        header: 'Note',
        size: 150,
        cell: (c) => {
          const d = c.row.original;
          return (
            <input className="cell-input" aria-label={`Note for row ${d.row.id}`} value={d.result?.analystNote ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => onPatch(d.row.id, { analystNote: e.target.value })} disabled={!d.result} />
          );
        },
      }),
    ],
    [onPatch, freshnessCfg],
  );

  const table = useReactTable({ data: props.data, columns, state: { sorting, columnVisibility }, onSortingChange: setSorting, onColumnVisibilityChange: setColumnVisibility, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getRowId: (d) => d.row.id });
  const rows = table.getRowModel().rows;
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 14 });
  const { onOrder } = props;
  useEffect(() => onOrder(rows.map((r) => r.id)), [rows, onOrder]);
  // Keep the selected row in view when Previous / Next (or the arrow keys) move through the list.
  useEffect(() => {
    if (!props.selectedId) return;
    const i = rows.findIndex((r) => r.id === props.selectedId);
    if (i >= 0) virt.scrollToIndex(i, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId]);
  const template = table.getVisibleLeafColumns().map((c) => `${c.getSize()}px`).join(' ');
  const width = table.getVisibleLeafColumns().reduce((n, c) => n + c.getSize(), 0);

  return (
    <div className="rt-wrap">
    <div className="rt-toolbar">
      {props.toolbar}
      {!props.toolbar && <div className="spacer" />}
      <details className="menu col-menu">
        <summary className="button small">Columns ▾</summary>
        <div className="menu-pop" role="menu" aria-label="Toggle columns">
          {table.getAllLeafColumns().map((c) => (
            <label key={c.id}>
              <input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />
              {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
            </label>
          ))}
        </div>
      </details>
    </div>
    <div className="table-scroll" ref={scrollRef} role="table" aria-rowcount={rows.length + 1}>
      <div style={{ width, minWidth: '100%' }}>
        <div className="thead" role="rowgroup" style={{ gridTemplateColumns: template }}>
          {table.getHeaderGroups()[0].headers.map((h) => {
            const dir = h.column.getIsSorted();
            return (
              <div key={h.id} role="columnheader" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
                {h.column.getCanSort() ? (
                  <button className="th-btn" onClick={h.column.getToggleSortingHandler()}>{flexRender(h.column.columnDef.header, h.getContext())}{dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''}</button>
                ) : (
                  flexRender(h.column.columnDef.header, h.getContext())
                )}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <p className="muted empty-msg">No rows match the current filter.</p>}
        <div className="tbody" role="rowgroup" style={{ height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((v) => {
            const r = rows[v.index];
            const d = r.original;
            return (
              <div
                key={r.id}
                role="row"
                aria-rowindex={v.index + 2}
                tabIndex={0}
                className={`tr ${props.selectedId === d.row.id ? 'selected' : ''} ${d.result && isFailure(d.result.status) ? 'failed' : ''}`}
                style={{ gridTemplateColumns: template, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
                onClick={() => props.onSelect(d.row.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(d.row.id); }
                }}
              >
                {r.getVisibleCells().map((c) => (
                  <div key={c.id} role="cell" className={`td td-${c.column.id}`}>{flexRender(c.column.columnDef.cell, c.getContext())}</div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </div>
  );
}
