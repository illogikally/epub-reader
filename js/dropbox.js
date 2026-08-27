// ============================================================
// Dropbox: OAuth (PKCE) and the handful of HTTP endpoints sync needs.
//
// This is a static site with no backend, so there is nowhere to keep a client
// secret and the only workable shape is PKCE with a public app key. The key
// below is public by design — it identifies the app, it does not authorise
// anything on its own.
//
// The flow is Dropbox's no-redirect variant: `redirect_uri` is omitted, so
// Dropbox shows the user a code to paste back here instead of navigating.
// That is deliberate. A redirect would leave the installed PWA for the system
// browser and never come back, and it would mean registering an exact redirect
// URI for every origin the reader is ever served from. One paste per device,
// then the refresh token carries it forever.
//
// SETUP (once, by hand):
//   1. dropbox.com/developers → Create app → Scoped access → App folder
//   2. Permissions tab → account_info.read, files.metadata.read,
//      files.metadata.write, files.content.read, files.content.write → Submit
//   3. Paste the App key below. No redirect URI needs registering.
//
// App folder, not Full Dropbox: every path below is rooted at Apps/<app name>/,
// '' is that folder itself, and nothing outside it is reachable. So the reader
// can never see a library you keep elsewhere in Dropbox — that is the price of
// not handing a web page the keys to the whole account. An earlier version of
// this comment said Full Dropbox while the code assumed nothing of the kind,
// which is how '/Books' ended up meaning a subfolder that had never been made.
// ============================================================

export const DROPBOX_APP_KEY = 'vmpzl8r39gqarek';

const SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.metadata.write',
  'files.content.read',
  'files.content.write',
].join(' ');

const AUTH_KEY = 'reader-dropbox-auth';   // { refresh_token, access_token, expires_at, account }
const VERIFIER_KEY = 'reader-dropbox-verifier';

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const RPC_BASE = 'https://api.dropboxapi.com/2/';
const CONTENT_BASE = 'https://content.dropboxapi.com/2/';

// ============================================================
// Token store
// ============================================================
// Kept out of `settings` on purpose: settings sync uploads that object to
// Dropbox, and a refresh token is per-device — sharing one would have two
// devices racing to refresh the same grant.
function readAuth() {
  try {
    const v = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    return (v && typeof v === 'object') ? v : null;
  } catch { return null; }
}
function writeAuth(auth) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

export function isConnected() {
  return !!(readAuth() || {}).refresh_token;
}
export function connectedAccount() {
  return (readAuth() || {}).account || '';
}
export function isConfigured() {
  return !!DROPBOX_APP_KEY;
}
export function disconnect() {
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
}

// ============================================================
// PKCE
// ============================================================
function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function makeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// Opens Dropbox's consent page in a new tab and returns the URL too, so a
// caller whose popup was blocked can offer it as a link instead. The verifier
// lives in sessionStorage rather than a module variable: on iOS the tab switch
// can evict the page, and coming back to a lost verifier means starting over.
export async function beginAuth() {
  if (!DROPBOX_APP_KEY) throw new Error('No Dropbox app key is set in js/dropbox.js.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await makeChallenge(verifier);
  const url = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
    client_id: DROPBOX_APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',   // we want a refresh token, not just four hours
    scope: SCOPES,
  });
  window.open(url, '_blank', 'noopener');
  return url;
}

async function postForm(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dropbox auth failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Exchanges the pasted code for tokens.
export async function finishAuth(code) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('Press Connect again — that request has expired.');
  const tok = await postForm({
    code: String(code || '').trim(),
    grant_type: 'authorization_code',
    client_id: DROPBOX_APP_KEY,
    code_verifier: verifier,
  });
  if (!tok.refresh_token) throw new Error('Dropbox returned no refresh token.');
  sessionStorage.removeItem(VERIFIER_KEY);
  writeAuth({
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    expires_at: Date.now() + (Number(tok.expires_in) || 14400) * 1000,
    account: '',
  });
  // The account label is cosmetic — a failure here doesn't undo the connection.
  try {
    const acct = await getAccount();
    const auth = readAuth();
    auth.account = acct.email || acct?.name?.display_name || '';
    writeAuth(auth);
  } catch {}
  return true;
}

// Access tokens last four hours. Refresh a minute early rather than waiting for
// a 401, so a long sync doesn't expire halfway through.
async function accessToken() {
  const auth = readAuth();
  if (!auth || !auth.refresh_token) throw new Error('Dropbox is not connected.');
  if (auth.access_token && auth.expires_at > Date.now() + 60000) return auth.access_token;
  const tok = await postForm({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    client_id: DROPBOX_APP_KEY,
  });
  auth.access_token = tok.access_token;
  auth.expires_at = Date.now() + (Number(tok.expires_in) || 14400) * 1000;
  writeAuth(auth);
  return auth.access_token;
}

// ============================================================
// Requests
// ============================================================
// Dropbox-API-Arg is an HTTP header, so it has to be ASCII. Book filenames very
// often are not — escape everything above 0x7e as \uXXXX, which Dropbox decodes.
function asciiArg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, c =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Carries Dropbox's structured `error` object, so callers can tell "the file
// isn't there" from "your token is bad" without matching on message strings.
export class DropboxError extends Error {
  constructor(endpoint, status, body) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    const summary = parsed?.error_summary || String(body || '').slice(0, 300);
    // The endpoint belongs in the message, not just in a field. Dropbox's
    // catch-all union tag serialises as the complete summary "other/...", so
    // without the call's name five different failures are indistinguishable —
    // which is exactly how one of them cost a debugging round-trip.
    super(`${endpoint} → ${status} ${summary || 'no detail'}`);
    this.name = 'DropboxError';
    this.endpoint = endpoint;
    this.status = status;
    this.summary = summary;
    this.body = String(body || '');
    this.detail = parsed?.error || null;
  }

  // Dropbox's unions all carry an `other` variant meaning "no reason given".
  // Worth one retry before it reaches a person.
  get isUnspecified() {
    return this.summary.startsWith('other/');
  }
  // e.g. isTag('path', 'not_found') — the summary reads "path/not_found/...".
  isTag(...tags) {
    return tags.every(t => this.summary.includes(t));
  }
}

// Every path through here is labelled with the endpoint it is calling, so a
// failure names itself. `body` is always a string, ArrayBuffer or typed array
// — never a stream — so the retries below can re-send it as-is.
async function authedFetch(endpoint, url, headers, body) {
  const send = async () => fetch(url, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${await accessToken()}` },
    body,
  });
  let res = await send();
  if (res.status === 401) {
    // Force a refresh and try once more: the token may have been revoked
    // server-side before its stated expiry.
    const auth = readAuth();
    if (auth) { auth.expires_at = 0; writeAuth(auth); }
    res = await send();
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After')) || 2;
    await new Promise(r => setTimeout(r, wait * 1000));
    res = await send();
  }
  if (!res.ok) {
    const err = new DropboxError(endpoint, res.status, await res.text());
    // "other/..." is Dropbox declining to say what went wrong. Give it one more
    // go before passing that non-answer on.
    if (err.isUnspecified) {
      await new Promise(r => setTimeout(r, 700));
      const retry = await send();
      if (retry.ok) return retry;
      throw new DropboxError(endpoint, retry.status, await retry.text());
    }
    throw err;
  }
  return res;
}

async function request(endpoint, url, headers, body) {
  const res = await authedFetch(endpoint, url, headers, body);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function rpc(endpoint, arg) {
  return request(endpoint, RPC_BASE + endpoint,
    { 'Content-Type': 'application/json' }, JSON.stringify(arg));
}

// ============================================================
// The endpoints sync uses
// ============================================================
export function getAccount() {
  // This one takes a bare null body, not an empty object.
  return request('users/get_current_account', RPC_BASE + 'users/get_current_account',
    { 'Content-Type': 'application/json' }, 'null');
}

// Every file entry in the folder, following the cursor to the end.
export async function listFolder(path) {
  const out = [];
  let page = await rpc('files/list_folder', {
    path,
    recursive: false,
    include_deleted: false,
    include_non_downloadable_files: false,
  });
  for (;;) {
    for (const e of page.entries || []) if (e['.tag'] === 'file') out.push(e);
    if (!page.has_more) break;
    page = await rpc('files/list_folder/continue', { cursor: page.cursor });
  }
  return out;
}

// Returns { buffer, meta }. The metadata rides back in a response header.
// No body and no Content-Type — the download endpoint rejects one.
export async function download(path) {
  const res = await authedFetch(
    'files/download',
    CONTENT_BASE + 'files/download',
    { 'Dropbox-API-Arg': asciiArg({ path }) },
    undefined,
  );
  let meta = null;
  try { meta = JSON.parse(res.headers.get('Dropbox-API-Result') || 'null'); } catch {}
  return { buffer: await res.arrayBuffer(), meta };
}

// `mode` is 'add' | 'overwrite' | { '.tag': 'update', update: rev } — the last
// is how the manifest write refuses to clobber a newer one.
export function upload(path, data, mode = 'add', autorename = false) {
  return request(
    'files/upload',
    CONTENT_BASE + 'files/upload',
    {
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': asciiArg({ path, mode, autorename, mute: true }),
    },
    data,
  );
}

export function deletePath(path) {
  return rpc('files/delete_v2', { path });
}

// A folder that already exists is the outcome we wanted, so a conflict is
// success. Dropbox creates intermediate folders for us.
export async function createFolder(path) {
  try {
    return await rpc('files/create_folder_v2', { path, autorename: false });
  } catch (err) {
    if (err instanceof DropboxError && err.isTag('path', 'conflict')) return null;
    throw err;
  }
}
