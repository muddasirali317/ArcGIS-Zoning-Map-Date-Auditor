// Prints how a saved portal item references services. Usage: node scripts/inspect-portal.mjs <fixture-prefix>...
import { readFileSync } from 'node:fs';

for (const n of process.argv.slice(2)) {
  const item = JSON.parse(readFileSync(`${n}.item.json`, 'utf8'));
  const data = JSON.parse(readFileSync(`${n}.data.json`, 'utf8'));
  const s = JSON.stringify(data);
  console.log(`\n## ${n} | ${item.type} | modified ${new Date(item.modified).toISOString().slice(0, 10)} | item.url ${item.url}`);
  console.log('data keys:', Object.keys(data).slice(0, 14).join(','));
  console.log('service urls:', [...new Set(s.match(/https?:[^"\\]*?(?:MapServer|FeatureServer|ImageServer)[^"\\]*/g) ?? [])].slice(0, 4));
  console.log('ids under keys:', [...new Set([...s.matchAll(/"(webmap|webmapId|itemId|mapItemId|webmapItemId|id)":"([0-9a-f]{32})"/gi)].map((m) => `${m[1]}=${m[2]}`))].slice(0, 6));
}
