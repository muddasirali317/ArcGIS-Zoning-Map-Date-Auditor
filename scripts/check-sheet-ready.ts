// Checks that a Sheet-ready CSV leaves every cell of the analyst's own sheet exactly as it was.
//   npx tsx scripts/check-sheet-ready.ts <source-table.json> <sheet-ready.csv>
import { readFileSync } from 'node:fs';
import { parseCsv } from '@zoning/core';

const [srcPath, outPath] = process.argv.slice(2);
const source: { table: string[][] } = JSON.parse(readFileSync(srcPath, 'utf8'));
const out = parseCsv(readFileSync(outPath, 'utf8'));
const width = source.table[0].length;

let changed = 0;
for (let i = 0; i < source.table.length; i++) for (let c = 0; c < width; c++) if ((source.table[i][c] ?? '') !== (out[i]?.[c] ?? '')) changed++;

console.log(`source lines ${source.table.length} | sheet-ready lines ${out.length} | source columns ${width} | sheet-ready columns ${out[0].length}`);
console.log(`cells of the analyst's own columns that differ from the source: ${changed}`);
console.log('added columns:', out[0].slice(width).join(' | '));
console.log('row 2 values :', out[1].slice(width).map((x) => x.slice(0, 26)).join(' | '));
