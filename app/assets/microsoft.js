/**
 * Microsoft sign-in and every OneDrive call Secure Box makes. No Microsoft JavaScript is loaded.
 *
 * Sign-in is OAuth 2.0's authorization code flow with PKCE, which Microsoft requires for apps
 * that run in a browser. The code comes back to this page (a full-page redirect, or a pop-up when
 * reconnecting) and is exchanged here for tokens. Access tokens last about an hour and are
 * renewed in the background with a refresh token, which Microsoft limits to 24 hours for browser
 * apps; after that, one more sign-in.
 *
 * The only permission asked for is Files.ReadWrite.AppFolder: Secure Box can see its own folder
 * in OneDrive ("Apps/Secure Box") and nothing else.
 */
import { fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from './crypto.js';
import { redirectUri } from './google.js';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA = 'https://graph.microsoft.com/beta'; // contentStream is only in beta so far
const APP_ROOT = '/me/drive/special/approot';
// The ways to read a file's bytes, best first (see OneDrive.content).
const READ_WAYS = ['stream', 'link', 'redirect'];
const WHOLE_FILE_LIMIT = 256 * 1024 * 1024; // the most of one file kept in memory, when ranges don't work
export const ONEDRIVE_SCOPE = 'Files.ReadWrite.AppFolder';
const SCOPES = `openid profile email offline_access ${ONEDRIVE_SCOPE}`;
const PENDING_KEY = 'unibox.msoauth';
const STATE_PREFIX = 'ms.';
const POPUP_PREFIX = 'popup.'; // the pop-up relay in google.js passes these on
const CHANNEL = 'unibox-auth';
// Upload pieces must be multiples of 320 KiB; 10 MiB keeps requests few and memory low.
export const ONEDRIVE_PIECE = 32 * 320 * 1024;

export class MicrosoftError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'MicrosoftError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
const challengeFor = async (verifier) => toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));

function authorizeUrl({ clientId, state, nonce, challenge, loginHint, prompt }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    response_mode: 'fragment', // the code never reaches a server log
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (prompt) params.set('prompt', prompt);
  if (loginHint && prompt !== 'select_account') params.set('login_hint', loginHint);
  return `${AUTHORITY}/authorize?${params}`;
}

/**
 * Full-page redirect to Microsoft. `prompt` may be '', 'select_account' or 'consent'; `silent`
 * asks Microsoft to answer without showing anything, which works when this browser is still
 * signed in to that account and Secure Box was approved before.
 */
export async function beginMicrosoftSignIn({ clientId, loginHint = '', prompt = '', silent = false }) {
  const state = `${STATE_PREFIX}${toBase64Url(randomBytes(16))}`;
  const nonce = toBase64Url(randomBytes(16));
  const verifier = toBase64Url(randomBytes(32));
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, nonce, verifier, silent }));
  location.assign(authorizeUrl({ clientId, state, nonce, challenge: await challengeFor(verifier), loginHint, prompt: silent ? 'none' : prompt }));
}

const OAUTH_ERRORS = {
  access_denied: 'Sign-in was cancelled.',
  interaction_required: 'Microsoft needs you to confirm the sign-in. Please try again.',
  login_required: 'Please sign in to your Microsoft account.',
  consent_required: 'Please allow the requested permissions to continue.',
  invalid_request: 'Microsoft rejected the sign-in request. Check the app registration’s settings.',
  unauthorized_client: 'This app registration doesn’t allow this sign-in. Its redirect address must be of the “Single-page application” type.',
  invalid_grant: 'The Microsoft sign-in expired. Please sign in again.',
};

const claimsOf = (idToken) => {
  try {
    return JSON.parse(fromUtf8(fromBase64Url(idToken.split('.')[1] || '')));
  } catch {
    throw new MicrosoftError('bad-token', 'Microsoft returned a malformed ID token.');
  }
};

/** Turns a token response into Secure Box's sign-in record, checking the ID token. */
function toAuth(clientId, data, { nonce = null, previous = null } = {}) {
  if (!data.access_token) throw new MicrosoftError('incomplete', 'Microsoft did not return the expected tokens.');
  let identity = previous?.identity || null;
  if (data.id_token) {
    const claims = claimsOf(data.id_token);
    const issuerOk = typeof claims.iss === 'string' && /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(claims.iss);
    const subject = claims.oid || claims.sub;
    if (claims.aud !== clientId || !issuerOk || (nonce && claims.nonce !== nonce) || typeof subject !== 'string') {
      throw new MicrosoftError('bad-token', 'The Microsoft sign-in failed validation. Please try again.');
    }
    const next = { sub: `ms:${subject}`, email: claims.email || claims.preferred_username || '' };
    if (previous && previous.identity.sub !== next.sub) throw new MicrosoftError('wrong-account', 'That was a different Microsoft account.');
    identity = next;
  }
  if (!identity) throw new MicrosoftError('incomplete', 'Microsoft did not say who signed in.');
  return {
    provider: 'microsoft',
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous?.refreshToken || '',
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    identity,
    driveGranted: typeof data.scope !== 'string' || /files\.readwrite\.appfolder/i.test(data.scope),
  };
}

async function tokenRequest(clientId, fields) {
  let res;
  try {
    res = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: SCOPES, ...fields }),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new MicrosoftError('network', 'Could not reach Microsoft. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const first = String(data.error_description || '').split(/\r?\n/)[0];
    throw new MicrosoftError(data.error || 'token', OAUTH_ERRORS[data.error] || first || `Microsoft sign-in failed (${res.status}).`, res.status);
  }
  return data;
}

/** After Microsoft's redirect: the verified sign-in, or null when this page load isn't one. */
export async function takeMicrosoftRedirect(clientId) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const ours = (p) => (p.get('state') || '').startsWith(STATE_PREFIX);
  const params = ours(fragment) ? fragment : ours(query) ? query : null;
  if (!params) return null;
  history.replaceState(null, '', `${location.pathname}${query.has('demo') ? '?demo' : ''}`);
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
  } catch {
    pending = null;
  }
  sessionStorage.removeItem(PENDING_KEY);
  try {
    if (!clientId) throw new MicrosoftError('setup', 'This copy of Secure Box isn’t set up for Microsoft sign-in.');
    if (!pending || params.get('state') !== pending.state) throw new MicrosoftError('state', 'The sign-in response did not match this browser tab. Please try again.');
    const error = params.get('error');
    if (error) throw new MicrosoftError(error, OAUTH_ERRORS[error] || `Microsoft sign-in failed (${error}).`);
    const code = params.get('code');
    if (!code) throw new MicrosoftError('incomplete', 'Microsoft did not return a sign-in code.');
    const data = await tokenRequest(clientId, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pending.verifier });
    return toAuth(clientId, data, { nonce: pending.nonce });
  } catch (err) {
    // A background (prompt=none) attempt that needs the person isn't an error to show.
    if (pending?.silent && err instanceof MicrosoftError) err.silent = true;
    throw err;
  }
}

/** Fresh tokens from the refresh token, without showing anything (it lasts 24 hours). */
export async function refreshMicrosoft(clientId, auth) {
  if (!auth?.refreshToken) throw new MicrosoftError('interaction_required', 'Please sign in to Microsoft again.');
  const data = await tokenRequest(clientId, { grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  return toAuth(clientId, data, { previous: auth });
}

/** Must be called straight from a click (pop-up blockers). Resolves with fresh tokens. */
export function reconnectMicrosoftWithPopup({ clientId, loginHint, previous, signal }) {
  // Opened first and pointed at Microsoft afterwards, so the click still counts.
  const popup = window.open('', 'unibox-microsoft', 'popup=yes,width=500,height=680');
  if (!popup) return Promise.reject(new MicrosoftError('popup-blocked', 'Your browser blocked the Microsoft window. Allow pop-ups for this site and try again.'));
  const state = `${POPUP_PREFIX}${STATE_PREFIX}${toBase64Url(randomBytes(16))}`;
  const nonce = toBase64Url(randomBytes(16));
  const verifier = toBase64Url(randomBytes(32));
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(CHANNEL);
    const timer = setTimeout(() => finish(reject, new MicrosoftError('timeout', 'Microsoft sign-in timed out.')), 5 * 60_000);
    const finish = (fn, value) => {
      clearTimeout(timer);
      channel.close();
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      popup.close();
      finish(reject, new MicrosoftError('cancelled', 'Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort);
    channel.onmessage = async (event) => {
      const params = new URLSearchParams(event.data?.fragment || '');
      if (params.get('state') !== state) return;
      try {
        const error = params.get('error');
        if (error) throw new MicrosoftError(error, OAUTH_ERRORS[error] || `Microsoft sign-in failed (${error}).`);
        const data = await tokenRequest(clientId, { grant_type: 'authorization_code', code: params.get('code') || '', redirect_uri: redirectUri(), code_verifier: verifier });
        finish(resolve, toAuth(clientId, data, { nonce, previous }));
      } catch (err) {
        finish(reject, err.code === 'wrong-account' ? new MicrosoftError('wrong-account', 'That was a different Microsoft account. Reconnect with the account you unlocked Secure Box with.') : err);
      }
    };
    challengeFor(verifier).then(
      (challenge) => {
        popup.location.href = authorizeUrl({ clientId, state, nonce, challenge, loginHint });
      },
      (err) => finish(reject, err),
    );
  });
}

// ---------------------------------------------------------------------------
// OneDrive (Microsoft Graph), inside the app's own folder
// ---------------------------------------------------------------------------
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "POST createUploadSession": which request it was, without item ids or the keys in links. */
export function requestLabel(method, url) {
  const { hostname, pathname } = new URL(url);
  if (hostname !== 'graph.microsoft.com') return `${method} ${hostname}`; // an upload or download link
  const step = pathname.split(/[/:]/).filter(Boolean).pop();
  return `${method} ${/^(content|children|createUploadSession|contentStream|approot)$/.test(step) ? step : 'item'}`;
}

async function graphError(res, label) {
  const codes = []; // Graph's error code, then any more precise inner ones
  let message = '';
  try {
    const { error } = await res.json();
    for (let e = error; e && codes.length < 4; e = e.innerError || e.innererror) if (e.code) codes.push(e.code);
    message = error?.message || '';
  } catch {
    /* not JSON */
  }
  const detail = `${res.status}${codes.length ? ` ${codes.join('/')}` : ''}`;
  console.warn(`OneDrive: ${label} failed (${detail}).`, message);
  if (res.status === 401) return new MicrosoftError('expired', 'Your Microsoft access expired. Reconnect to continue.', 401);
  if (res.status === 403) return new MicrosoftError('drive-scope', 'Secure Box needs permission to use its folder in your OneDrive.', 403);
  if (res.status === 404) return new MicrosoftError('not-found', 'That file is missing from your OneDrive.', 404);
  if (res.status === 409) return new MicrosoftError('exists', message || 'A file with that name already exists in OneDrive.', 409);
  if (res.status === 412) return new MicrosoftError('conflict', 'The file changed on another device.', 412);
  if (res.status === 507 || codes.includes('quotaLimitReached')) return new MicrosoftError('quota', 'Your OneDrive is full.', res.status);
  // Anything else: say which request it was, so the message alone tells what to fix.
  return new MicrosoftError('drive', `${message || 'OneDrive returned an error'} (OneDrive: ${label}, ${detail})`, res.status);
}

export class OneDrive {
  constructor(getToken) {
    this.getToken = getToken;
    this.urls = new Map(); // item id -> { url, until }: OneDrive's short-lived download links
    this.way = null; // the way of reading files that last worked for this account
  }

  /** One Graph call; busy servers (429/503) are asked again after the wait they name. */
  async call(path, init = {}, { auth = true, okStatuses = [] } = {}) {
    const url = path.startsWith('https://') ? path : `${GRAPH}${path}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          ...init,
          headers: { ...(auth ? { Authorization: `Bearer ${this.getToken()}` } : {}), ...(init.headers || {}) },
          cache: 'no-store',
          credentials: 'omit',
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err; // cancelled, not offline
        console.warn(`OneDrive: ${requestLabel(init.method || 'GET', url)} could not be sent.`, err?.message);
        throw new MicrosoftError('network', 'Could not reach OneDrive. Check your connection and try again.');
      }
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await pause(Math.min(30, Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000);
        continue;
      }
      if (!res.ok && !okStatuses.includes(res.status)) throw await graphError(res, requestLabel(init.method || 'GET', url));
      return res;
    }
  }

  async json(path, init, options) {
    return (await this.call(path, init, options)).json();
  }

  /** What's in Secure Box's folder (its top level). */
  async listRoot() {
    const items = [];
    for (let next = `${APP_ROOT}/children?$select=id,name,eTag,size,file,folder&$top=200`; next; ) {
      const page = await this.json(next);
      items.push(...(page.value || []));
      next = page['@odata.nextLink'] || '';
    }
    return items;
  }

  /**
   * A file's bytes, all of them or [start, end], as a Response: 206 for a range, or 200 with the
   * whole file if OneDrive ignores the range. Three ways, best first; the one that works is
   * remembered and tried first from then on:
   *   stream    Graph sends the bytes itself, to a request carrying the access token (contentStream).
   *   link      the file's short-lived download link, which needs no token. Microsoft is retiring
   *             these links, and asked for by name ($select) they're often left out already.
   *   redirect  /content, which redirects to that same link.
   */
  async content(id, range) {
    const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
    const ways = this.way ? [this.way, ...READ_WAYS.filter((w) => w !== this.way)] : READ_WAYS;
    let failure;
    for (const way of ways) {
      try {
        const res = await this.readVia(way, id, headers);
        this.way = way;
        return res;
      } catch (err) {
        if (err?.name === 'AbortError' || err?.code === 'expired') throw err; // no other way does better
        console.warn(`OneDrive: reading a file via "${way}" failed (${err?.status || err?.code}).`, err?.message);
        failure ??= err;
      }
    }
    throw failure;
  }

  async readVia(way, id, headers) {
    const item = `/me/drive/items/${encodeURIComponent(id)}`;
    if (way === 'stream') return this.call(`${GRAPH_BETA}${item}/contentStream`, { headers });
    if (way === 'redirect') return this.call(`${item}/content`, { headers }); // the browser follows it to the file
    // The download link is already authorized: no token goes with it.
    for (let attempt = 0; ; attempt++) {
      const url = await this.downloadUrl(id); // asks Graph (with the token) unless the link is fresh
      try {
        return await this.call(url, { headers }, { auth: false });
      } catch (err) {
        if (![401, 403].includes(err.status)) throw err;
        this.urls.delete(id); // the link ran out: ask for a new one, once
        // A refused link isn't the sign-in expiring: the next way gets its turn.
        if (attempt) throw new MicrosoftError('no-link', 'OneDrive refused its own download link.', err.status);
      }
    }
  }

  async downloadUrl(id) {
    const hit = this.urls.get(id);
    if (hit && hit.until > Date.now()) return hit.url;
    // The whole item: asked for by name ($select), the link is often left out.
    const item = await this.json(`/me/drive/items/${encodeURIComponent(id)}`);
    const url = item['@microsoft.graph.downloadUrl'] || item['@content.downloadUrl'];
    if (!url) throw new MicrosoftError('no-link', 'OneDrive didn’t offer a download link for that file.');
    this.urls.set(id, { url, until: Date.now() + 20 * 60_000 });
    return url;
  }

  /**
   * Where the streaming worker can fetch this file itself, with byte ranges, in one request (as
   * with Google Drive), best first: the file's download address, which needs no token (when
   * OneDrive doesn't list it, following /content finds it), then Graph's contentStream with the
   * access token.
   */
  async streamSources(id, { fresh = false } = {}) {
    if (fresh) this.urls.delete(id);
    const direct = await this.downloadUrl(id)
      .catch(() => this.followContent(id))
      .catch(() => null);
    const stream = { url: `${GRAPH_BETA}/me/drive/items/${encodeURIComponent(id)}/contentStream`, token: this.getToken() };
    return direct ? [{ url: direct }, stream] : [stream];
  }

  /** The download address /content redirects to (asked for one byte), kept like a download link. */
  async followContent(id) {
    const res = await this.call(`/me/drive/items/${encodeURIComponent(id)}/content`, { headers: { Range: 'bytes=0-0' } });
    Promise.resolve(res.body?.cancel()).catch(() => {});
    if (!res.url || new URL(res.url).hostname === 'graph.microsoft.com') return null; // not a download address
    this.urls.set(id, { url: res.url, until: Date.now() + 20 * 60_000 });
    return res.url;
  }

  async readText(id) {
    return (await this.content(id)).text();
  }

  /** Encrypted bytes [start, end], as a Response. */
  async readRange(id, start, end) {
    if (this.whole?.id === id) return new Response(this.whole.bytes.subarray(start, end + 1));
    if (!this.wholeOnly) {
      try {
        const res = await this.content(id, [start, end]);
        if (res.status === 206) return res;
        // 200: OneDrive ignored the range and sent the whole file. Keep it (if it isn't huge), so
        // the next pieces don't download all of it again.
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length <= WHOLE_FILE_LIMIT) this.whole = { id, bytes };
        return new Response(bytes.subarray(start, end + 1));
      } catch (err) {
        if (err.code !== 'network') throw err;
        // If a plain read works, this browser just can't ask for a range: read whole files from now on.
        const bytes = new Uint8Array(await (await this.content(id)).arrayBuffer());
        this.wholeOnly = true;
        this.whole = { id, bytes };
      }
    }
    if (this.whole?.id !== id) this.whole = { id, bytes: new Uint8Array(await (await this.content(id)).arrayBuffer()) };
    return new Response(this.whole.bytes.subarray(start, end + 1));
  }

  async revision(id) {
    return (await this.json(`/me/drive/items/${encodeURIComponent(id)}?$select=eTag`)).eTag;
  }

  /** A new text file in Secure Box's folder; fails if the name is taken. Returns { id, eTag }. */
  async createText(name, text) {
    const item = await this.json(`${APP_ROOT}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    return { id: item.id, eTag: item.eTag };
  }

  /** Replaces a text file; with `ifMatch`, only if nobody else changed it since. Returns the new eTag. */
  async updateText(id, text, ifMatch = '') {
    const item = await this.json(`/me/drive/items/${encodeURIComponent(id)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(ifMatch ? { 'If-Match': ifMatch } : {}) },
      body: text,
    });
    this.urls.delete(id);
    if (this.whole?.id === id) this.whole = null;
    return item.eTag;
  }

  /** The id of Secure Box's own folder. Some OneDrives don't make anything inside it by its alias. */
  async rootId() {
    if (!this.root) this.root = (await this.json(APP_ROOT)).id;
    return this.root;
  }

  /** A folder at the top of Secure Box's folder (made if it isn't there yet): its id. */
  async folder(name) {
    const find = async () => (await this.listRoot()).find((i) => i.name === name && i.folder)?.id;
    const found = await find();
    if (found) return found;
    try {
      // No conflictBehavior: the default fails if the name is taken. Never 'replace', which
      // would throw away the files in the folder.
      const item = await this.json(`/me/drive/items/${encodeURIComponent(await this.rootId())}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {} }),
      });
      return item.id;
    } catch (err) {
      if (err.code !== 'exists') throw err;
      const made = await find(); // another device made it a moment ago
      if (made) return made;
      throw err;
    }
  }

  async remove(id) {
    await this.call(`/me/drive/items/${encodeURIComponent(id)}`, { method: 'DELETE' }, { okStatuses: [404] }); // to OneDrive's recycle bin
    this.urls.delete(id);
  }

  /**
   * Starts a resumable upload into `parentId`. Returns send(piece, offset, total) for the piece
   * writer: null until the last piece, then the new file's id.
   */
  async startUpload({ parentId, folderName, name, signal }) {
    // Into a folder by its id, or by its name inside Secure Box's folder (OneDrive makes it if needed).
    const where = parentId ? `/me/drive/items/${encodeURIComponent(parentId)}` : `${APP_ROOT}:/${encodeURIComponent(folderName)}/`;
    const session = await this.json(`${where}${parentId ? ':/' : ''}${encodeURIComponent(name)}:/createUploadSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail', name } }), // the name matches the path
    });
    const { uploadUrl } = session;
    if (!uploadUrl) throw new MicrosoftError('upload', 'OneDrive did not start the upload.');
    const send = async (piece, offset, total) => {
      // The upload link is already authorized: no token goes with it.
      const res = await this.call(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${offset + piece.length - 1}/${total}` }, body: piece, signal }, { auth: false });
      if (res.status === 202) return null;
      return (await res.json()).id;
    };
    send.pieceSize = ONEDRIVE_PIECE;
    send.abort = () => this.call(uploadUrl, { method: 'DELETE' }, { auth: false, okStatuses: [404] }).catch(() => {});
    return send;
  }
}
