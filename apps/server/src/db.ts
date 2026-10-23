/**
 * SQLite storage (PRD 8, 9). Every result is written the moment it arrives, so a crash or a closed
 * tab loses nothing; re-sync and resume are both "queue the rows that have no stored result".
 * Uses Node's built-in node:sqlite (no native add-on to install).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { CheckResult, CheckRow } from '@zoning/core';

// createRequire keeps bundlers / test runners from trying to resolve the experimental built-in themselves.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface SheetRecord {
  url: string;
  rows: CheckRow[];
  removed: CheckRow[];
  syncedAt: string;
  /** The sheet as last read (row 0 = headers), so exports and write-back line up with it. */
  table: string[][] | null;
  mapping: unknown | null;
}

export class Store {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sheets (
        sheet_key TEXT PRIMARY KEY, url TEXT NOT NULL, rows TEXT NOT NULL, removed TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        sheet_key TEXT NOT NULL, fingerprint TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (sheet_key, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS url_cache (
        canonical TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL
      );
    `);
    // Added in Phase 3; databases created earlier get the columns on first start.
    const cols = (this.db.prepare('PRAGMA table_info(sheets)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('table_json')) this.db.exec('ALTER TABLE sheets ADD COLUMN table_json TEXT');
    if (!cols.includes('mapping_json')) this.db.exec('ALTER TABLE sheets ADD COLUMN mapping_json TEXT');
  }

  getSheet(key: string): SheetRecord | null {
    const r = this.db.prepare('SELECT url, rows, removed, synced_at, table_json, mapping_json FROM sheets WHERE sheet_key = ?').get(key) as
      | { url: string; rows: string; removed: string; synced_at: string; table_json: string | null; mapping_json: string | null }
      | undefined;
    return r
      ? {
          url: r.url,
          rows: JSON.parse(r.rows),
          removed: JSON.parse(r.removed),
          syncedAt: r.synced_at,
          table: r.table_json ? JSON.parse(r.table_json) : null,
          mapping: r.mapping_json ? JSON.parse(r.mapping_json) : null,
        }
      : null;
  }

  /** `table` / `mapping` left undefined keep what is stored. */
  saveSheet(key: string, url: string, rows: CheckRow[], removed: CheckRow[], table?: string[][], mapping?: unknown): void {
    this.db
      .prepare(
        `INSERT INTO sheets (sheet_key, url, rows, removed, synced_at, table_json, mapping_json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sheet_key) DO UPDATE SET url = excluded.url, rows = excluded.rows, removed = excluded.removed, synced_at = excluded.synced_at,
           table_json = COALESCE(excluded.table_json, sheets.table_json), mapping_json = COALESCE(excluded.mapping_json, sheets.mapping_json)`,
      )
      .run(key, url, JSON.stringify(rows), JSON.stringify(removed), new Date().toISOString(), table ? JSON.stringify(table) : null, mapping ? JSON.stringify(mapping) : null);
  }

  getResults(key: string): Map<string, CheckResult> {
    const rows = this.db.prepare('SELECT fingerprint, json FROM results WHERE sheet_key = ?').all(key) as { fingerprint: string; json: string }[];
    return new Map(rows.map((r) => [r.fingerprint, JSON.parse(r.json) as CheckResult]));
  }

  putResult(key: string, fingerprint: string, result: CheckResult): void {
    this.db
      .prepare('INSERT INTO results (sheet_key, fingerprint, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(sheet_key, fingerprint) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(key, fingerprint, JSON.stringify(result), new Date().toISOString());
  }

  putResults(key: string, items: { fingerprint: string; result: CheckResult }[]): void {
    this.db.exec('BEGIN');
    try {
      for (const i of items) this.putResult(key, i.fingerprint, i.result);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getCached(canonical: string, ttlMs: number, now = Date.now()): CheckResult | null {
    const r = this.db.prepare('SELECT json, fetched_at FROM url_cache WHERE canonical = ?').get(canonical) as { json: string; fetched_at: number } | undefined;
    return r && now - r.fetched_at <= ttlMs ? (JSON.parse(r.json) as CheckResult) : null;
  }

  putCached(canonical: string, result: CheckResult, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO url_cache (canonical, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(canonical) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      .run(canonical, JSON.stringify(result), now);
  }

  close(): void {
    this.db.close();
  }
}
