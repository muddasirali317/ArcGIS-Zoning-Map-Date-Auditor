// Live check of viewer-link resolution against real ArcGIS Online items. Needs the server running.
const API = 'http://127.0.0.1:8787';
const T = [
  ['Configurable app (Know Your Zone)', 'https://www.arcgis.com/apps/instant/lookup/index.html?appid=aa18a2d8737c4d66bb6434a09e17203a'],
  ['Org-hosted instant app', 'https://floridadisaster.maps.arcgis.com/apps/instant/lookup/index.html?appid=aa18a2d8737c4d66bb6434a09e17203a'],
  ['Web map (St. Louis land use)', 'https://www.arcgis.com/home/webmap/viewer.html?webmap=2eb53198cfbb4367b4ab2f8c983756ec'],
  ['Web map, data inside (Preston)', 'https://www.arcgis.com/home/webmap/viewer.html?webmap=245f3f4699fe4b9799ebc18f1b5e5cf2&extent=-111.923,42.0628'],
  ['Experience Builder (York County)', 'https://experience.arcgis.com/experience/e827d330f20a4508aa6777bf2c0b94e3'],
  ['Map Viewer layers= (Morris)', 'https://www.arcgis.com/apps/mapviewer/index.html?layers=950ea57cb2844757b1ab34d9f51c0b8c'],
  ['Dashboard', 'https://www.arcgis.com/apps/dashboards/5c6ba4921438443babc66c49e0088e35'],
  ['Hub slug link (cannot be resolved)', 'https://hub.arcgis.com/datasets/NJTPA::monmouth-county-zoning/explore'],
  ['Item that does not exist', 'https://www.arcgis.com/apps/instant/index.html?appid=00000000000000000000000000000000'],
];
const rows = T.map(([city, url], i) => ({ id: String(i + 2), sheetRow: i + 2, city, state: '', county: '', url, fingerprint: 'f' + i, preIssues: [], extra: {} }));
const { id } = await (await fetch(`${API}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows, sheetKey: 'smoke-apps', force: true }) })).json();
let snap;
do { await new Promise((r) => setTimeout(r, 700)); snap = await (await fetch(`${API}/api/runs/${id}`)).json(); } while (snap.stats.state !== 'done');
for (const r of snap.results.sort((a, b) => a.sheetRow - b.sheetRow)) {
  console.log(`${r.city}\n   ${r.status}  ${r.primaryDate}  [${r.dateSource}, ${r.dateConfidence}]  item=${r.itemModifiedDate}  layers=${r.layersChecked}`);
  console.log(`   ${(r.resolvedFrom || r.issueReason || '').slice(0, 230)}`);
}
