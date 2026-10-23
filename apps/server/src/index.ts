import { buildApp } from './app';

const port = Number(process.env.PORT ?? 8787);
// Local tool: listen on loopback only, so the proxy is not exposed to the network.
const host = process.env.HOST ?? '127.0.0.1';

const app = buildApp(); // data/auditor.db unless DB_PATH is set
app.listen({ port, host }).then(
  () => {
    console.log(`Zoning Map Date Auditor server on http://${host}:${port}`);
    if (process.env.UPSTREAM_PROXY) console.log(`Using upstream proxy ${process.env.UPSTREAM_PROXY}`);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
