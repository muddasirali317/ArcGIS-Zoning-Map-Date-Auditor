/**
 * Headless run of the whole pipeline against a Google Sheet (needs the server running):
 *   npx tsx scripts/audit-sheet.ts <sheet-url> [out-dir] [changed|failed|all]
 * Prints the PRD section 12 report and writes the Full CSV.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFullCsv, buildSheetReadyCsv, groupByCity, isFailure, normalizeName, suggestDateFields, summarize, buildRows, type CheckResult } from '@zoning/core';

const API = process.env.API ?? 'http://127.0.0.1:8787';
const [sheetUrl, outDir = 'out', mode = 'changed'] = process.argv.slice(2);
if (!sheetUrl) throw new Error('usage: audit-sheet.ts <sheet-url> [out-dir] [changed|failed|all]');

const post = async (path: string, body: unknown) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
};

const sheet = await post('/api/sheet', { url: sheetUrl });
// ALT_URL_COL=<column index> turns on the fallback link column (used only when the Map URL cell has no link)
if (process.env.ALT_URL_COL) sheet.mapping.altUrl = Number(process.env.ALT_URL_COL);
const built = buildRows(sheet.table, sheet.mapping);
console.log(`mapping ${JSON.stringify(sheet.mapping)} | ${sheet.table.length - 1} sheet rows -> ${built.rows.length} checks (${built.blankDropped} blank, ${built.split} split, ${built.duplicates} duplicate-flagged)`);

const m = /spreadsheets\/d\/([\w-]+)/.exec(sheetUrl)!;
const sheetKey = `${m[1]}:${/gid=(\d+)/.exec(sheetUrl)?.[1] ?? '0'}`;
const plan = await post('/api/sync', { sheetKey, sheetUrl, rows: built.rows, mode, table: sheet.table, mapping: sheet.mapping });
console.log('SYNC', JSON.stringify(plan.counts));
const t0 = Date.now();
const carried: CheckResult[] = plan.results;
let snap: { stats: { state: string; completed: number; total: number }; results: CheckResult[]; openHosts?: string[] } = { stats: { state: 'done', completed: 0, total: 0 }, results: [] };
const id = plan.runId;
while (id) {
  snap = await (await fetch(`${API}/api/runs/${id}`)).json();
  process.stdout.write(`\r${snap.stats.completed}/${snap.stats.total} ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  if (snap.stats.state === 'done') break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`\nfinished in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

if (snap.openHosts?.length) console.log('HOSTS SKIPPED BY THE CIRCUIT BREAKER:', snap.openHosts.join(', '));
const results = new Map([...carried, ...snap.results].map((r) => [r.id, r]));
const ordered = built.rows.flatMap((r) => (results.has(r.id) ? [results.get(r.id)!] : []));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'full.csv'), buildFullCsv(ordered));
writeFileSync(join(outDir, 'results.json'), JSON.stringify(ordered, null, 1));
writeFileSync(join(outDir, 'sheet-ready.csv'), buildSheetReadyCsv(sheet.table, built.rows, Object.fromEntries(results)));

const s = summarize(built.rows, results);
console.log('\nSUMMARY', JSON.stringify(s));
const byStatus: Record<string, number> = {};
for (const r of ordered) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log('BY STATUS', JSON.stringify(byStatus));
const warnings: Record<string, number> = {};
for (const r of ordered) for (const i of r.issues) if (!isFailure(i.code) && i.code !== 'OK_NO_DATE') warnings[i.code] = (warnings[i.code] ?? 0) + 1;
console.log('WARNINGS', JSON.stringify(warnings));

console.log('\nPER CITY (cities with issues first)');
for (const g of groupByCity(built.rows, results)) {
  if (g.issueList.length === 0) continue;
  console.log(`${g.city}, ${g.state}: ${g.maps} map(s), ${g.checked} checked, ${g.issues} issue(s)`);
  for (const i of g.issueList) console.log(`    ${i.code}  ${i.reason.slice(0, 150)}`);
}

const cfg = (await (await fetch(API + '/api/config')).json()).config;
const sugg = suggestDateFields(ordered, new Set(cfg.dateFieldNames.map(normalizeName)));
console.log('\nDATE FIELD SUGGESTIONS (not on the list yet)');
for (const s of sugg.slice(0, 15)) console.log(`  ${s.likelihood.padEnd(8)} ${s.name.padEnd(24)} maps=${s.maps} mapsWithoutDate=${s.mapsWithoutDate}  e.g. ${s.examples.join('; ')}`);
const apps = ordered.filter((r) => r.resolvedFrom);
console.log(`\nVIEWER LINKS RESOLVED: ${apps.length}`);
for (const r of apps.slice(0, 25)) console.log(`  ${r.id} ${r.city}: ${r.status} ${r.primaryDate} [${r.dateSource}] ${r.dateConfidence} <- ${r.resolvedFrom}`.slice(0, 260));
