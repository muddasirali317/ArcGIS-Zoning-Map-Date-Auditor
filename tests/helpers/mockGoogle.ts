/** A local stand-in for Google's OAuth token endpoint and the Sheets API v4, recording what it is sent. */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface MockGoogle {
  base: string;
  /** The grid served for the tab (row 0 = headers). Cells may be strings or {text, link}. */
  setGrid(grid: (string | { text: string; link: string })[][]): void;
  /** The authorization URL the app produced: the token endpoint checks the PKCE verifier against its challenge and grants its scope. */
  expectAuth(authUrl: string): void;
  tokenCalls: Record<string, string>[];
  writes: { auth: string; body: any }[];
  failNextSheetsCall(status: number): void;
  expireTokens(): void;
  forbid(sheetId: string): void;
  close(): Promise<void>;
}

export async function startMockGoogle(opts: { sheetId?: string; tabTitle?: string; gid?: number } = {}): Promise<MockGoogle> {
  const sheetId = opts.sheetId ?? 'SHEET123';
  const tabTitle = opts.tabTitle ?? "Zoning O'Brien";
  const gid = opts.gid ?? 0;
  let grid: (string | { text: string; link: string })[][] = [];
  let challenge = '';
  let lastScope = '';
  let failStatus = 0;
  let tokenSeq = 0;
  let expired = false;
  let validAccess = '';
  const forbidden = new Set<string>();
  const tokenCalls: Record<string, string>[] = [];
  const writes: { auth: string; body: any }[] = [];
  const sockets = new Set<Socket>();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (url.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(raw));
        tokenCalls.push(form);
        if (form.grant_type === 'authorization_code') {
          const ok = form.code === 'goodcode' && createHash('sha256').update(form.code_verifier ?? '').digest('base64url') === challenge;
          if (!ok) return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or PKCE verifier' });
        } else if (form.grant_type === 'refresh_token') {
          if (form.refresh_token !== 'rt1') return json(res, 400, { error: 'invalid_grant' });
        }
        validAccess = `at${++tokenSeq}`;
        expired = false;
        return json(res, 200, {
          access_token: validAccess,
          refresh_token: form.grant_type === 'authorization_code' ? 'rt1' : undefined,
          expires_in: 3600,
          scope: lastScope,
        });
      }
      // ---- Sheets API
      const m = /^\/v4\/spreadsheets\/([^/:]+)(\/values:batchUpdate)?$/.exec(url.pathname);
      if (!m) return json(res, 404, { error: { message: 'no such route' } });
      if (failStatus) {
        const s = failStatus;
        failStatus = 0;
        return json(res, s, { error: { message: 'injected' } });
      }
      const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (expired || bearer !== validAccess) return json(res, 401, { error: { message: 'token expired' } });
      if (forbidden.has(m[1]) || m[1] !== sheetId) return json(res, forbidden.has(m[1]) ? 403 : 404, { error: { message: 'no access' } });

      if (m[2]) {
        writes.push({ auth: bearer, body: JSON.parse(raw) });
        return json(res, 200, { totalUpdatedCells: 1 });
      }
      if (url.searchParams.get('includeGridData') === 'true') {
        const range = url.searchParams.get('ranges');
        if (range !== `'${tabTitle.replace(/'/g, "''")}'`) return json(res, 400, { error: { message: `bad range ${range}` } });
        const rowData = grid.map((r) => ({
          values: r.map((c) => (typeof c === 'string' ? (c === '' ? {} : { formattedValue: c }) : { formattedValue: c.text, hyperlink: c.link })),
        }));
        return json(res, 200, { sheets: [{ data: [{ rowData }] }] });
      }
      return json(res, 200, { sheets: [{ properties: { sheetId: gid, title: tabTitle } }, { properties: { sheetId: 999, title: 'Other' } }] });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    setGrid: (g) => (grid = g),
    expectAuth: (authUrl) => {
      const q = new URL(authUrl).searchParams;
      challenge = q.get('code_challenge') ?? '';
      lastScope = q.get('scope') ?? '';
    },
    tokenCalls,
    writes,
    failNextSheetsCall: (s) => (failStatus = s),
    expireTokens: () => (expired = true),
    forbid: (id) => forbidden.add(id),
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}
