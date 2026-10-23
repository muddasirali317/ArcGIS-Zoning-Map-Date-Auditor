/** Adding date-field names to config/config.json without reformatting the rest of the file. */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeName, type RawConfig } from '@zoning/core';

const VALID_NAME = /^[A-Za-z][A-Za-z0-9_ -]{0,63}$/;

export function addDateFieldNames(configPath: string, names: string[]): { added: string[]; skipped: string[] } {
  const text = readFileSync(configPath, 'utf8');
  const config = JSON.parse(text) as RawConfig;
  const known = new Set(config.dateFieldNames.map(normalizeName));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!VALID_NAME.test(name) || known.has(normalizeName(name))) {
      skipped.push(name);
      continue;
    }
    known.add(normalizeName(name));
    added.push(name);
  }
  if (added.length === 0) return { added, skipped };

  // Insert before the closing bracket of dateFieldNames, keeping the file's own layout.
  const m = /("dateFieldNames"\s*:\s*\[)([\s\S]*?)(\n?[ \t]*\])/.exec(text);
  if (!m) throw new Error('config.json: could not find dateFieldNames to edit.');
  const body = m[2].replace(/\s+$/, '');
  const insert = added.map((n) => JSON.stringify(n)).join(', ');
  const updated = `${text.slice(0, m.index)}${m[1]}${body},\n    ${insert}${m[3]}${text.slice(m.index + m[0].length)}`;
  JSON.parse(updated); // never leave a broken config behind
  writeFileSync(configPath, updated);
  return { added, skipped };
}
