/**
 * Re-sync planning (PRD 4.6). Each row has a fingerprint (hash of City + State + URL). A row whose
 * fingerprint already has a stored result is unchanged and is not queued again.
 */
import { isFailure } from './issues';
import type { CheckResult, CheckRow } from './types';

/** changed: new, changed or never finished. failed: those plus every failure. nodate: those plus every map that loaded without a date (after adding a date field name). all: everything. */
export type SyncMode = 'changed' | 'failed' | 'nodate' | 'all';

export interface SyncPlan {
  /** Rows to put in the queue. */
  toCheck: CheckRow[];
  /** Rows whose stored result is reused as-is. */
  unchanged: CheckRow[];
  /** Same sheet row as before, but City / State / URL changed. */
  changed: CheckRow[];
  /** No previous row at that position and no stored result. */
  added: CheckRow[];
  /** Rows that were in the previous sync and are gone now. Marked "removed", never silently deleted. */
  removed: CheckRow[];
}

/**
 * @param prev    rows from the previous sync (empty on first sync)
 * @param next    rows from the sheet now
 * @param stored  stored results by fingerprint
 */
export function planSync(prev: CheckRow[], next: CheckRow[], stored: Map<string, CheckResult>, mode: SyncMode): SyncPlan {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const nextFingerprints = new Set(next.map((r) => r.fingerprint));
  const plan: SyncPlan = { toCheck: [], unchanged: [], changed: [], added: [], removed: [] };

  for (const row of next) {
    const result = stored.get(row.fingerprint);
    const before = prevById.get(row.id);
    const isNewOrChanged = !result;
    if (isNewOrChanged) (before && before.fingerprint !== row.fingerprint ? plan.changed : plan.added).push(row);
    else plan.unchanged.push(row);

    const queue =
      mode === 'all' ||
      isNewOrChanged ||
      (mode === 'failed' && isFailure(result!.status)) ||
      (mode === 'nodate' && result!.status === 'OK_NO_DATE');
    if (queue) plan.toCheck.push(row);
  }
  const seenRemoved = new Set<string>();
  for (const row of prev) {
    if (!nextFingerprints.has(row.fingerprint) && !seenRemoved.has(row.fingerprint)) {
      seenRemoved.add(row.fingerprint);
      plan.removed.push(row);
    }
  }
  return plan;
}
