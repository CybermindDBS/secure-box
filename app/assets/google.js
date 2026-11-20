/**
 * Google sign-in (OpenID Connect via top-level redirect, plus a pop-up "reconnect" when the
 * one-hour Drive token runs out) and every Google Drive call Secure Box makes.
 * No Google JavaScript is loaded into the page.
 */
import { randomBytes, toBase64Url, toHex, fromBase64Url, fromUtf8 } from './crypto.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const PENDING_KEY = 'unibox.oauth';
const POPUP_PREFIX = 'popup.';
const CHANNEL = 'unibox-auth';

export class GoogleError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
export function redirectUri() {
  const path = location.pathname.endsWith('/') ? `${location.pathname}index.html` : location.pathname;
  return `${location.origin}${path}`;
}

function authUrl({ clientId, state, nonce, loginHint, prompt }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token id_token',
    scope: `openid email ${DRIVE_SCOPE}`,
    state,
    nonce,
  });
  if (prompt) params.set('prompt', prompt);
  if (loginHint && prompt !== 'select_account') params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params}`;
}

/**
 * Full-page redirect to Google; `prompt` may be '', 'select_account' or 'consent'.
 * `silent` asks Google to answer without showing anything (prompt=none): it works when this
 * browser is already signed in to the hinted account and has approved Secure Box before.
 */
export function beginGoogleSignIn({ clientId, loginHint = '', prompt = '', silent = false }) {
  const state = toBase64Url(randomBytes(16));
  const nonce = toBase64Url(randomBytes(16));
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, nonce, silent }));
  location.assign(authUrl({ clientId, state, nonce, loginHint, prompt: silent ? 'none' : prompt }));
}

const OAUTH_ERRORS = {
  access_denied: 'Sign-in was cancelled.',
  interaction_required: 'Google needs you to confirm the sign-in. Please try again.',
  login_required: 'Please sign in to your Google account.',
  account_selection_required: 'Choose your Google account to continue.',
  consent_required: 'Please allow the requested permissions to continue.',
  invalid_request: 'Google rejected the sign-in request. Check the OAuth client settings.',
  unauthorized_client: 'This OAuth client is not allowed to sign in this way. Use a "Web application" client.',
};

/** Validates a token response (fragment parameters) against the pending state/nonce. */
function parseAuthResponse(params, { clientId, state, nonce }) {
  if (!state || params.get('state') !== state) {
    throw new GoogleError('state', 'The sign-in response did not match this browser tab. Please try again.');
  }
  const error = params.get('error');
  if (error) throw new GoogleError(error, OAUTH_ERRORS[error] || `Google sign-in failed (${error}).`);
  const accessToken = params.get('access_token');
  const idToken = params.get('id_token');
  if (!accessToken || !idToken) throw new GoogleError('incomplete', 'Google did not return the expected tokens.');
  let claims;
  try {
    claims = JSON.parse(fromUtf8(fromBase64Url(idToken.split('.')[1] || '')));
  } catch {
    throw new GoogleError('bad-token', 'Google returned a malformed ID token.');
  }
  const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const audienceOk = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
  if (!issuerOk || !audienceOk || claims.nonce !== nonce || typeof claims.sub !== 'string') {
    throw new GoogleError('bad-token', 'The Google sign-in failed validation. Please try again.');
  }
  const granted = params.get('scope');
  const expiresIn = Number(params.get('expires_in')) || 3600;
  return {
    accessToken,
    identity: { sub: claims.sub, email: claims.email || '' },
    driveGranted: granted === null || granted.split(/\s+/).includes(DRIVE_SCOPE),
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/** After Google's redirect: returns the verified result and scrubs tokens from the address bar. */
export function takeGoogleRedirect(clientId) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const params = fragment.has('state') ? fragment : query.has('state') && query.has('error') ? query : null;
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
    return parseAuthResponse(params, { clientId, state: pending?.state, nonce: pending?.nonce });
  } catch (err) {
    // A background (prompt=none) attempt that needs the person is not an error to show.
    if (pending?.silent && err instanceof GoogleError) err.silent = true;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reconnect pop-up (Google's access tokens last one hour)
// ---------------------------------------------------------------------------
export const isAuthPopupReturn = () => (new URLSearchParams(location.hash.slice(1)).get('state') || '').startsWith(POPUP_PREFIX);

/** Runs inside the pop-up after Google redirects back: hands the tokens to the app tab. */
export function relayAuthPopupReturn() {
  const fragment = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ fragment });
  channel.close();
  setTimeout(() => window.close(), 50);
}

/** Must be called directly from a click (pop-up blockers). Resolves with fresh tokens. */
export function reconnectWithPopup({ clientId, loginHint, expectedSub, signal }) {
  const state = `${POPUP_PREFIX}${toBase64Url(randomBytes(16))}`;
  const nonce = toBase64Url(randomBytes(16));
  const popup = window.open(authUrl({ clientId, state, nonce, loginHint }), 'unibox-google', 'popup=yes,width=500,height=680');
  if (!popup) {
    return Promise.reject(new GoogleError('popup-blocked', 'Your browser blocked the Google window. Allow pop-ups for this site and try again.'));
  }
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(CHANNEL);
    const timer = setTimeout(() => finish(reject, new GoogleError('timeout', 'Google sign-in timed out.')), 5 * 60_000);
    const finish = (fn, value) => {
      clearTimeout(timer);
      channel.close();
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new GoogleError('cancelled', 'Cancelled.'));
    signal?.addEventListener('abort', onAbort);
    channel.onmessage = (event) => {
      const params = new URLSearchParams(event.data?.fragment || '');
      if (params.get('state') !== state) return;
      try {
        const result = parseAuthResponse(params, { clientId, state, nonce });
        if (expectedSub && result.identity.sub !== expectedSub) {
          throw new GoogleError('wrong-account', 'That was a different Google account. Reconnect with the account you unlocked Secure Box with.');
        }
        finish(resolve, result);
      } catch (err) {
        finish(reject, err);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------
async function driveError(res) {
  let message = '';
  let reasons = '';
  try {
    const { error } = await res.json();
    message = error?.message || '';
    reasons = [error?.status, ...(error?.errors || []).map((e) => e.reason), ...(error?.details || []).map((d) => d.reason)].filter(Boolean).join(' ');
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return new GoogleError('expired', 'Your Google access expired. Reconnect to continue.', 401);
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reasons) || /has not been used|is disabled/i.test(message)) {
    return new GoogleError('drive-disabled', 'The Google Drive API is turned off for this Google Cloud project. Enable it in the Cloud Console, wait a minute, then try again.', 403);
  }
  if (res.status === 403 && /insufficient/i.test(`${reasons} ${message}`)) {
    return new GoogleError('drive-scope', 'Secure Box needs permission to use Google Drive.', 403);
  }
  if (res.status === 403 && /storageQuota|quotaExceeded/i.test(reasons)) {
    return new GoogleError('quota', 'Your Google Drive is full.', 403);
  }
  return new GoogleError('drive', message || `Google Drive returned an error (${res.status}).`, res.status);
}

export class Drive {
  constructor(getToken) {
    this.getToken = getToken;
  }

  async call(url, init = {}, { raw = false } = {}) {
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.getToken()}`, ...(init.headers || {}) },
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err; // cancelled, not offline
      throw new GoogleError('network', 'Could not reach Google Drive. Check your connection and try again.');
    }
    if (!res.ok && !(raw && res.status === 308)) throw await driveError(res);
    return res;
  }

  /** Everything Secure Box keeps in Drive, except the encrypted file blobs. */
  async findUnibox() {
    const kinds = ['root', 'files', 'keyring', 'vault'];
    const q = `(${kinds.map((k) => `appProperties has { key='unibox' and value='${k}' }`).join(' or ')}) and trashed = false`;
    const params = new URLSearchParams({
      q,
      spaces: 'drive',
      fields: 'files(id,name,parents,appProperties,headRevisionId,createdTime)',
      orderBy: 'createdTime',
      pageSize: '100',
    });
    const { files = [] } = await (await this.call(`${API}/files?${params}`)).json();
    return files.map((f) => ({ ...f, kind: f.appProperties?.unibox, kid: f.appProperties?.kid || '' }));
  }

  async createFolder(name, parentId, kind) {
    const body = { name, mimeType: FOLDER, appProperties: { unibox: kind }, ...(parentId ? { parents: [parentId] } : {}) };
    const res = await this.call(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()).id;
  }

  async createText({ name, parentId, text, appProperties, description = '' }) {
    const boundary = `unibox-${toHex(randomBytes(12))}`;
    const meta = { name, mimeType: 'application/json', description, appProperties, ...(parentId ? { parents: [parentId] } : {}) };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const res = await this.call(`${UPLOAD}/files?uploadType=multipart&fields=id,headRevisionId`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  }

  async readText(id) {
    return (await this.call(`${API}/files/${encodeURIComponent(id)}?alt=media`)).text();
  }

  async revision(id) {
    return (await (await this.call(`${API}/files/${encodeURIComponent(id)}?fields=headRevisionId`)).json()).headRevisionId;
  }

  async updateText(id, text) {
    const res = await this.call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=headRevisionId`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    return (await res.json()).headRevisionId;
  }

  async trash(id) {
    await this.call(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  /** Starts a resumable upload of `size` encrypted bytes; returns a function that sends pieces. */
  async startUpload({ name, parentId, size, appProperties, signal }) {
    const res = await this.call(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({ name, mimeType: 'application/octet-stream', parents: [parentId], appProperties }),
    });
    const session = res.headers.get('Location');
    if (!session) throw new GoogleError('upload', 'Google Drive did not start the upload.');
    return async (piece, offset, total) => {
      const put = await this.call(
        session,
        { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${offset + piece.length - 1}/${total}` }, body: piece, signal },
        { raw: true },
      );
      return put.status === 308 ? null : (await put.json()).id;
    };
  }

  async readRange(id, start, end) {
    const res = await this.call(`${API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { Range: `bytes=${start}-${end}` } });
    return res.body;
  }
}
