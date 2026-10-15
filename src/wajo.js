'use strict';

/**
 * Wajo AI client.
 *
 * Zero-dependency client for the Wajo (wajo.ai) "Fo" agent. Covers the full
 * account + inference lifecycle, all over plain HTTPS:
 *
 *   Signup  (login.wajo.ai)
 *     POST /email-otp/start   {email,inviteCode,returnTo,signup,password}
 *     POST /email-otp/verify  {email,code,returnTo,signup,password} -> {customToken}
 *     Firebase: accounts:signInWithCustomToken -> {idToken,refreshToken}
 *     POST /auth/callback     {idToken,email,refreshToken,returnTo,...} -> Set-Cookie
 *
 *   Inference  (agent.api.wajo.ai, gRPC-gateway/JSON)
 *     POST /v1/agents/{agentId}/sessions:generateId -> {sessionId}
 *     POST /v1/sessions/{sessionId}:run  {chatMessage,orgId} -> streaming result frames
 *
 *   Account
 *     POST /auth/refresh      {refreshToken} -> rotated cookies
 *     GET  /v1/sessions:recent
 *
 * Auth is cookie-based (`wajo_token` httpOnly JWT + `wajo_refresh`); the same
 * jar also works as `Authorization: Bearer <wajo_token>` on the agent API.
 */

const https = require('https');
const { randomUUID } = require('crypto');

const LOGIN_BASE = 'https://login.wajo.ai';
const AGENT_BASE = 'https://agent.api.wajo.ai';
const FIREBASE_API_KEY = 'AIzaSyDBSRcra-726bb44A7dO40QP4NiL7eAIA0';

const DEFAULT_AGENT_ID = '803df601-94a8-4935-91a5-e1a1efa2cb0d';
const DEFAULT_HANDLE = 'fo';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

/** Tiny https wrapper returning { status, headers, body }. */
function httpsRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          accept: 'application/json',
          'user-agent': UA,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, body: raw });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse one Set-Cookie header value into {name,value}. */
function cookieFromSetCookie(sc) {
  if (!sc) return null;
  const first = Array.isArray(sc) ? sc[0] : sc;
  const eq = first.indexOf('=');
  if (eq === -1) return null;
  return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).split(';')[0] };
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** The Wajo REST/inference client for a single account. */
class WajoClient {
  constructor({ cookies = {}, orgId = null, agentId = DEFAULT_AGENT_ID, handle = DEFAULT_HANDLE } = {}) {
    this.cookies = { ...cookies };
    this.orgId = orgId;
    this.agentId = agentId;
    this.handle = handle;
    this.token = cookies.wajo_token || null;
  }

  get authed() {
    return !!(this.cookies.wajo_token || this.cookies.wajo_refresh);
  }

  authHeaders() {
    const h = { cookie: cookieHeader(this.cookies) };
    if (this.cookies.wajo_token) h.authorization = `Bearer ${this.cookies.wajo_token}`;
    return h;
  }

  // ---- Signup -------------------------------------------------------------

  /** Step 1: request an OTP to the inbox. Creates the account on verify. */
  static async emailOtpStart({ email, password, returnTo = 'https://wajo.ai/fo', inviteCode = '' }) {
    const r = await httpsRequest(`${LOGIN_BASE}/email-otp/start`, {
      method: 'POST',
      body: { email, inviteCode, returnTo, signup: true, password },
    });
    return { status: r.status, body: parseJson(r.body) || r.body };
  }

  /**
   * Full signup: OTP start -> (caller supplies code) -> verify -> Firebase
   * exchange -> /auth/callback. Returns a WajoClient with cookies set.
   *
   * @param {object} o
   * @param {string} o.email
   * @param {string} o.password
   * @param {() => Promise<string>} o.getCode  async fn returning the 6-digit code
   */
  static async signup({ email, password, getCode, returnTo = 'https://wajo.ai/fo' }) {
    const start = await WajoClient.emailOtpStart({ email, password, returnTo });
    if (start.status !== 200 || start.body.accepted !== true) {
      throw new Error(`email-otp/start failed: ${start.status} ${JSON.stringify(start.body)}`);
    }
    const code = await getCode();
    if (!code) throw new Error('no verification code provided');
    const verify = await WajoClient.emailOtpVerify({ email, password, code, returnTo });
    const fb = await WajoClient.firebaseCustomTokenSignIn(verify.customToken);
    const cb = await WajoClient.authCallback({
      idToken: fb.idToken,
      refreshToken: fb.refreshToken,
      email,
      returnTo,
    });
    const client = new WajoClient({ cookies: cb.cookies, agentId: DEFAULT_AGENT_ID });
    client.userId = cb.body && cb.body.userId;
    client.email = email;
    return client;
  }

  static async emailOtpVerify({ email, password, code, returnTo = 'https://wajo.ai/fo' }) {
    const r = await httpsRequest(`${LOGIN_BASE}/email-otp/verify`, {
      method: 'POST',
      body: { email, code, returnTo, signup: true, password },
    });
    const body = parseJson(r.body) || {};
    if (r.status !== 200 || !body.customToken) {
      throw new Error(`email-otp/verify failed: ${r.status} ${r.body.slice(0, 200)}`);
    }
    return body;
  }

  /** Exchange a Firebase custom token for an ID token + refresh token. */
  static async firebaseCustomTokenSignIn(customToken) {
    const r = await httpsRequest(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
      { method: 'POST', body: { token: customToken, returnSecureToken: true } }
    );
    const body = parseJson(r.body) || {};
    if (r.status !== 200 || !body.idToken) {
      throw new Error(`firebase signInWithCustomToken failed: ${r.status} ${r.body.slice(0, 200)}`);
    }
    // refreshToken may also arrive in a Set-Cookie header (sticky session).
    if (!body.refreshToken && r.headers['set-cookie']) {
      const sc = r.headers['set-cookie'].map((s) => cookieFromSetCookie(s)).filter(Boolean);
      const rt = sc.find((c) => /refresh/i.test(c.name));
      if (rt) body.refreshToken = rt.value;
    }
    return body;
  }

  /** Establish the Wajo session (sets wajo_token / wajo_refresh cookies). */
  static async authCallback({ idToken, email, refreshToken, returnTo = 'https://wajo.ai/fo' }) {
    const r = await httpsRequest(`${LOGIN_BASE}/auth/callback`, {
      method: 'POST',
      headers: { origin: 'https://login.wajo.ai', referer: 'https://login.wajo.ai/' },
      body: {
        idToken,
        email,
        refreshToken,
        returnTo,
        idpIdToken: '',
        idpProviderId: '',
        demoCoupon: '',
        posthogDistinctId: '',
        posthogHandoffDistinctId: '',
        codeChallenge: '',
      },
    });
    const body = parseJson(r.body) || {};
    if (r.status !== 200 && !body.ok) {
      throw new Error(`/auth/callback failed: ${r.status} ${r.body.slice(0, 200)}`);
    }
    const cookies = {};
    const sc = r.headers['set-cookie'] || [];
    for (const c of sc) {
      const parsed = cookieFromSetCookie(c);
      if (parsed) cookies[parsed.name] = parsed.value;
    }
    return { body, cookies };
  }

  /** Rotate the session using the refresh cookie. */
  async refresh() {
    const r = await httpsRequest(`${LOGIN_BASE}/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: this.cookies.wajo_refresh },
    });
    const sc = r.headers['set-cookie'] || [];
    for (const c of sc) {
      const parsed = cookieFromSetCookie(c);
      if (parsed) this.cookies[parsed.name] = parsed.value;
    }
    this.token = this.cookies.wajo_token || this.token;
    return r.status;
  }

  // ---- Inference ----------------------------------------------------------

  /** Ask the backend for a fresh server-side session id for the agent. */
  async generateSessionId() {
    const r = await httpsRequest(
      `${AGENT_BASE}/v1/agents/${this.agentId}/sessions:generateId`,
      { method: 'POST', headers: this.authHeaders(), body: {} }
    );
    const body = parseJson(r.body) || {};
    if (r.status !== 200 || !body.sessionId) {
      throw new Error(`generateId failed: ${r.status} ${r.body.slice(0, 200)}`);
    }
    return body.sessionId;
  }

  /**
   * Run one chat message and stream decoded events to onEvent(evt).
   * Returns { sessionId, text } once the run completes.
   *
   * Each NDJSON line is { result: { sessionId, streamCursor, <kind>: {...} } }.
   * Kinds: started, userMessage, reset, agentState, agentActivity, agentText
   * (delta), textFinal, runDone.
   */
  run(chatMessage, { sessionId, orgId, onEvent, timeoutMs = 120000 } = {}) {
    return (async () => {
      const sid = sessionId || (await this.generateSessionId());
      const oid = orgId || this.orgId;
      let text = '';
      await new Promise((resolve, reject) => {
        const u = new URL(`${AGENT_BASE}/v1/sessions/${sid}:run`);
        const payload = JSON.stringify({ chatMessage, ...(oid ? { orgId: oid } : {}) });
        const req = https.request(
          {
            hostname: u.hostname,
            port: 443,
            path: u.pathname,
            method: 'POST',
            headers: {
              accept: 'text/event-stream',
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              'user-agent': UA,
              ...this.authHeaders(),
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              let e = '';
              res.on('data', (c) => (e += c));
              res.on('end', () => reject(new Error(`run failed: ${res.statusCode} ${e.slice(0, 200)}`)));
              return;
            }
            let buf = '';
            res.on('data', (chunk) => {
              buf += chunk.toString('utf8');
              const lines = buf.split('\n');
              buf = lines.pop();
              for (const line of lines) {
                const evt = decodeRunLine(line);
                if (!evt) continue;
                if (evt.kind === 'agentText') text += evt.data.text || '';
                else if (evt.kind === 'textFinal') text = evt.data.text || text;
                if (onEvent) onEvent(evt);
                if (evt.kind === 'runDone') {
                  res.destroy();
                  resolve();
                }
              }
            });
            res.on('end', resolve);
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('run stream timeout')));
        req.write(payload);
        req.end();
      });
      return { sessionId: sid, text };
    })();
  }

  // ---- Account ------------------------------------------------------------

  async recentSessions() {
    const r = await httpsRequest(`${AGENT_BASE}/v1/sessions:recent`, { headers: this.authHeaders() });
    return parseJson(r.body) || {};
  }

  toJSON() {
    return {
      email: this.email,
      userId: this.userId,
      orgId: this.orgId,
      agentId: this.agentId,
      handle: this.handle,
      cookies: this.cookies,
    };
  }
}

/** Decode one NDJSON run line into { kind, data, sessionId, cursor }. */
function decodeRunLine(line) {
  const s = line.trim();
  if (!s) return null;
  const obj = parseJson(s);
  if (!obj || !obj.result) return null;
  const r = obj.result;
  const kinds = ['started', 'userMessage', 'reset', 'agentState', 'agentActivity', 'agentText', 'textFinal', 'runDone', 'error'];
  for (const k of kinds) {
    if (k in r) return { kind: k, data: r[k], sessionId: r.sessionId, cursor: r.streamCursor };
  }
  return null;
}

module.exports = {
  WajoClient,
  httpsRequest,
  cookieFromSetCookie,
  cookieHeader,
  parseJson,
  decodeRunLine,
  sleep,
  DEFAULT_AGENT_ID,
  DEFAULT_HANDLE,
  FIREBASE_API_KEY,
  LOGIN_BASE,
  AGENT_BASE,
  randomUUID,
};
