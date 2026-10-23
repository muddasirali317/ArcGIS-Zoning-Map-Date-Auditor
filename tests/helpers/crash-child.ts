/**
 * Child process for the resume test: starts a sync against the mock server and keeps running until the
 * parent kills it. argv: <dbPath> <configPath> <origin> <count>
 */
import { buildApp } from '../../apps/server/src/app';
import { makeRows } from './mockArcgis';

const [dbPath, configPath, origin, count] = process.argv.slice(2);
const app = buildApp({ dbPath, configPath, allowPrivateHosts: true });
const rows = makeRows(origin, Number(count));

const res = await app.inject({ method: 'POST', url: '/api/sync', payload: { sheetKey: 'crash:0', sheetUrl: 'x', rows, mode: 'changed' } });
const { runId } = res.json();
console.log('STARTED');
setInterval(async () => {
  const snap = (await app.inject({ url: `/api/runs/${runId}` })).json();
  console.log(`PROGRESS ${snap.stats.completed}`);
}, 40);
