/**
 * Google sign-in (OAuth 2.0 authorization code flow with PKCE) and the Sheets API calls the tool needs:
 * read a private sheet, and write the audit columns back.
 *
 * - Read-only scope by default; the write scope is asked for only when the analyst clicks "Enable write-back".
 * - Tokens are kept in this process's memory only. They are never written to disk or sent to the browser,
 *   so restarting the server signs you out (PRD 9: never store tokens).
 * - Needs GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET for web clients). See the README for setup.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SheetError } from '@zoning/core';

export const SCOPE_READ = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const SCOPE_WRITE = 'https://www.googleapis.com/auth/spreadsheets';

export interface GoogleOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  /** Overridable so tests can point at a local stand-in for Google. */
  authBase?: string;
  tokenUrl?: string;
  sheetsBase?: string;
  fetchFn?: typeof fetch;
}

interface Tokens {
  access: string;
  refresh?: string;
  expiresAt: number;
  scopes: string[];
}

const b64url = (b: Buffer) => b.toString('base64url');

export class GoogleAuth {
  private tokens: Tokens | null = null;
  private pending = new Map<string, { verifier: string; write: boolean; created: number }>();
  private f: typeof fetch;
  readonly opts: Required<Omit<GoogleOptions, 'clientId' | 'clientSecret' | 'fetchFn'>> & Pick<GoogleOptions, 'clientId' | 'clientSecret'>;

  constructor(o: GoogleOptions) {
    this.f = o.fetchFn ?? fetch;
    this.opts = {
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      redirectUri: o.redirectUri,
      authBase: o.authBase ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: o.tokenUrl ?? 'https://oauth2.googleapis.com/token',
      sheetsBase: o.sheetsBase ?? 'https://sheets.googleapis.com/v4',
    };
  }

  get configured(): boolean {
    return Boolean(this.opts.clientId);
  }

  status() {
    const t = this.tokens;
    return { configured: this.configured, signedIn: Boolean(t), canWrite: Boolean(t?.scopes.includes(SCOPE_WRITE)) };
  }

  signOut() {
    this.tokens = null;
  }

  /** Start sign-in. Returns the Google URL to send the browser to. */
  start(write: boolean): string {
    if (!this.configured) throw new Error('Google sign-in is not set up. Set GOOGLE_CLIENT_ID (see the README).');
    for (const [k, v] of this.pending) if (Date.now() - v.created > 10 * 60_000) this.pending.delete(k); // abandoned sign-ins
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    this.pending.set(state, { verifier, write, created: Date.now() });
    const q = new URLSearchParams({
      client_id: this.opts.clientId!,
      redirect_uri: this.opts.redirectUri,
      response_type: 'code',
      scope: write ? SCOPE_WRITE : SCOPE_READ,
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    });
    return `${this.opts.authBase}?${q}`;
  }

  async handleCallback(code: string, state: string): Promise<void> {
    const p = this.pending.get(state);
    if (!p) throw new Error('Unknown or expired sign-in attempt. Start again from the tool.');
    this.pending.delete(state);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.opts.redirectUri,
      client_id: this.opts.clientId!,
      code_verifier: p.verifier,
    });
    if (this.opts.clientSecret) body.set('client_secret', this.opts.clientSecret);
    this.tokens = await this.exchange(body, p.write ? [SCOPE_WRITE] : [SCOPE_READ], this.tokens?.refresh);
  }

  private async exchange(body: URLSearchParams, fallbackScopes: string[], oldRefresh?: string): Promise<Tokens> {
    const res = await this.f(this.opts.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`Google refused the sign-in: ${j.error_description ?? j.error ?? res.status}`);
    return {
      access: j.access_token,
      refresh: j.refresh_token ?? oldRefresh,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 - 30_000,
      scopes: j.scope ? j.scope.split(' ') : fallbackScopes,
    };
  }

  /** A valid access token, refreshed if it has expired. Null when not signed in. */
  async accessToken(force = false): Promise<string | null> {
    const t = this.tokens;
    if (!t) return null;
    if (!force && Date.now() < t.expiresAt) return t.access;
    if (!t.refresh) {
      this.tokens = null;
      return null;
    }
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: this.opts.clientId! });
    if (this.opts.clientSecret) body.set('client_secret', this.opts.clientSecret);
    try {
      this.tokens = await this.exchange(body, t.scopes, t.refresh);
    } catch {
      this.tokens = null;
      return null;
    }
    return this.tokens.access;
  }

  /** Sheets API call with the signed-in user's token; one refresh-and-retry on 401. */
  async api(path: string, init: RequestInit = {}): Promise<any> {
    const url = `${this.opts.sheetsBase}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      if (!token) throw new SheetError('SHEET_PRIVATE', 'Sign in with Google first.');
      const res = await this.f(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
      if (res.status === 401 && attempt === 0) continue;
      const j = (await res.json().catch(() => ({}))) as any;
      if (res.status === 401 || res.status === 403) {
        throw new SheetError('SHEET_PRIVATE', 'This Google account cannot open that sheet' + (init.method === 'POST' ? ', or does not have edit access.' : '. Ask the owner to share it with you.'));
      }
      if (res.status === 404) throw new SheetError('SHEET_FETCH_FAILED', 'Google could not find that sheet (404). Check the link.');
      if (!res.ok) throw new SheetError('SHEET_FETCH_FAILED', `Google Sheets said: ${j?.error?.message ?? res.status}`);
      return j;
    }
    throw new SheetError('SHEET_PRIVATE', 'Google rejected the saved sign-in. Sign in again.');
  }
}

// ---------------------------------------------------------------------------
// Sheets helpers
// ---------------------------------------------------------------------------

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const a1Title = (title: string) => `'${title.replace(/'/g, "''")}'`;

export async function findTab(g: GoogleAuth, sheetId: string, gid: string): Promise<{ title: string; sheetId: number }> {
  const meta = await g.api(`/spreadsheets/${sheetId}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`);
  const tab = (meta.sheets ?? []).map((s: any) => s.properties).find((p: any) => String(p.sheetId) === gid);
  if (!tab) throw new SheetError('SHEET_EMPTY', `That sheet has no tab with gid=${gid}. Check the number after "gid=" in the link.`);
  return tab;
}

/** The tab as a table of strings. A cell that shows text but carries a hyperlink keeps the link (the CSV export loses it). */
export async function readTab(g: GoogleAuth, sheetId: string, gid: string): Promise<string[][]> {
  const tab = await findTab(g, sheetId, gid);
  const fields = 'sheets(data(rowData(values(formattedValue,hyperlink))))';
  const j = await g.api(`/spreadsheets/${sheetId}?ranges=${encodeURIComponent(a1Title(tab.title))}&includeGridData=true&fields=${encodeURIComponent(fields)}`);
  const rowData: any[] = j.sheets?.[0]?.data?.[0]?.rowData ?? [];
  const table = rowData.map((r) =>
    (r.values ?? []).map((c: any) => {
      const text: string = c?.formattedValue ?? '';
      const link: string | undefined = c?.hyperlink;
      if (link && !/https?:\/\//i.test(text)) return text ? `${text} ${link}` : link;
      return text;
    }),
  );
  const width = Math.max(0, ...table.map((r: string[]) => r.length));
  return table.map((r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}

/** Write each audit column as its own block. RAW: values are stored as text, never evaluated as formulas. */
export async function writeColumns(g: GoogleAuth, sheetId: string, gid: string, columns: { index: number; cells: string[] }[]): Promise<void> {
  const tab = await findTab(g, sheetId, gid);
  const data = columns.map((c) => ({
    range: `${a1Title(tab.title)}!${columnLetter(c.index)}1:${columnLetter(c.index)}${c.cells.length}`,
    majorDimension: 'COLUMNS',
    values: [c.cells],
  }));
  await g.api(`/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
}
