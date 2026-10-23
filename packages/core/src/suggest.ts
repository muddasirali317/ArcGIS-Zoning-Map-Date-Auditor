/**
 * Suggestions for the date-field list (PRD 5.3, 13): date fields found under names that are not on
 * the list, ranked by how likely they are to be a "last updated" field and how many maps would gain a date.
 */
import { normalizeName } from './config';
import type { CheckResult } from './types';

export type Likelihood = 'likely' | 'maybe' | 'unlikely';

export interface FieldSuggestion {
  /** Name as it appears most often. */
  name: string;
  likelihood: Likelihood;
  /** Maps that have a date field with this name. */
  maps: number;
  /** Of those, maps that loaded but found no date, which adding this name could fix. */
  mapsWithoutDate: number;
  examples: string[];
}

// "mod" counts only as a whole word-part (MODDATE, DATEMOD, DATE_MOD), so MODEL or MODE do not.
const LIKELY = /(edit|updat|modif|revis|amend|chang|effective|adopt|ordinance|ord_?date|last|refresh|maint|publish|current|(^|[^a-z])mod(date|[^a-z]|$)|date_?mod(ified)?($|[^a-z]))/i;
const UNLIKELY = /(creat|install|entered|entry|start|begin|birth|survey|record|sale|deed|plat|issued|expir|(^|[^a-z])end($|[^a-z])|^gdb_|delet|archiv)/i;

export function classifyFieldName(name: string): Likelihood {
  if (UNLIKELY.test(name) && !LIKELY.test(name)) return 'unlikely';
  if (LIKELY.test(name) && !UNLIKELY.test(name)) return 'likely';
  return 'maybe';
}

/** `otherDateFields` entries look like `Layer name.FIELD`; layer names may contain dots, field names cannot. */
export function fieldOf(entry: string): string {
  return entry.slice(entry.lastIndexOf('.') + 1);
}

export function suggestDateFields(results: CheckResult[], configured: Set<string>): FieldSuggestion[] {
  const byName = new Map<string, { names: Map<string, number>; maps: Set<string>; noDate: Set<string>; examples: Set<string> }>();
  for (const r of results) {
    for (const entry of r.otherDateFields) {
      const name = fieldOf(entry);
      const key = normalizeName(name);
      if (!key || configured.has(key)) continue;
      const g = byName.get(key) ?? { names: new Map(), maps: new Set(), noDate: new Set(), examples: new Set() };
      g.names.set(name, (g.names.get(name) ?? 0) + 1);
      g.maps.add(r.id);
      if (r.status === 'OK_NO_DATE') g.noDate.add(r.id);
      if (g.examples.size < 3) g.examples.add(`${r.city}${r.state ? `, ${r.state}` : ''}`);
      byName.set(key, g);
    }
  }
  const order: Record<Likelihood, number> = { likely: 0, maybe: 1, unlikely: 2 };
  return [...byName.values()]
    .map((g) => {
      const name = [...g.names].sort((a, b) => b[1] - a[1])[0][0];
      return { name, likelihood: classifyFieldName(name), maps: g.maps.size, mapsWithoutDate: g.noDate.size, examples: [...g.examples] };
    })
    .sort((a, b) => order[a.likelihood] - order[b.likelihood] || b.mapsWithoutDate - a.mapsWithoutDate || b.maps - a.maps || a.name.localeCompare(b.name));
}
