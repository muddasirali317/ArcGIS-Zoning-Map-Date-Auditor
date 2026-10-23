import { localDate } from './dates';
import type { RawConfig } from './config';

export type Freshness = 'green' | 'yellow' | 'orange' | 'red' | 'grey';

export interface FreshnessInfo {
  level: Freshness;
  /** Text always shown next to the colour, so colour is never the only signal. */
  label: string;
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/** Age of a YYYY-MM-DD date in years, relative to the analyst's local today. */
export function ageYears(date: string, now = new Date()): number {
  const today = Date.parse(`${localDate(now)}T00:00:00Z`);
  return (today - Date.parse(`${date}T00:00:00Z`)) / MS_PER_YEAR;
}

export function freshness(date: string, cfg: RawConfig['freshness'] | undefined, now = new Date()): FreshnessInfo {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { level: 'grey', label: 'None' };
  const t = cfg ?? { greenYears: 1, yellowYears: 3, orangeYears: 5 };
  const age = ageYears(date, now);
  if (age < 0) return { level: 'green', label: 'future date' };
  if (age <= t.greenYears) return { level: 'green', label: `≤ ${t.greenYears} yr` };
  if (age <= t.yellowYears) return { level: 'yellow', label: `${t.greenYears}–${t.yellowYears} yr` };
  if (age <= t.orangeYears) return { level: 'orange', label: `${t.yellowYears}–${t.orangeYears} yr` };
  return { level: 'red', label: `> ${t.orangeYears} yr` };
}
