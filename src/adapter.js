'use strict';

/**
 * Wajo pool adapter — OpenAI-compatible HTTP server backed by many Wajo
 * accounts, with round-robin selection and automatic failover.
 *
 * Every account is a WajoClient (cookies) from accounts.jsonl. A request is
 * pinned to the next healthy account; if a run fails with an auth error the
 * account is cooled down and the request is retried on the next one. Sessions
 * are created lazily per account and reused, so consecutive turns share context
 * when the client pins a session with the `user` field.
 *
 * Routes:
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *   GET  /health
 *   GET  /pool
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WajoClient } = require('./wajo');

const PORT = Number(process.env.PORT || 8783);
const HOST = process.env.HOST || '127.0.0.1';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(__dirname, '..', 'accounts.jsonl');
const MODEL_ID = process.env.WAJO_MODEL || 'wajo/fo';
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 60000);

function loadAccounts(file) {
  if (!fs.existsSync(file)) throw new Error(`accounts file not found: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

class Pool {
  constructor(accounts) {
    this.accounts = accounts.map((a) => ({
      raw: a,
      client: new WajoClient({ cookies: a.cookies || a, orgId: a.orgId, agentId: a.agentId }),
      cooldownUntil: 0,
      sessionId: null,
      ok: 0,
      fail: 0,
    }));
    this.cursor = 0;
  }

  size() {
    return this.accounts.length;
  }

  healthy() {
    const now = Date.now();
    return this.accounts.filter((a) => a.cooldownUntil <= now);
  }

  /** Next healthy account, round-robin; falls back to any if all cooled. */
  pick() {
    const now = Date.now();
    for (let i = 0; i < this.accounts.length; i++) {
      const a = this.accounts[this.cursor % this.accounts.length];
      this.cursor++;
      if (a.cooldownUntil <= now) return a;
    }
    return this.accounts[this.cursor++ % this.accounts.length];
  }

  stats() {
    const now = Date.now();
    return this.accounts.map((a, i) => ({
      index: i,
      email: a.raw.email || a.client.email || null,
      healthy: a.cooldownUntil <= now,
      cooldownMs: Math.max(0, a.cooldownUntil - now),
      session: a.sessionId,
      ok: a.ok,
      fail: a.fail,
    }));
  }
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map((c) => c.text || '').join(' ').trim();
    }
  }
  return '';
}

/** Flatten an OpenAI message list into one Wajo prompt (Wajo runs single-turn). */
function buildPrompt(messages = []) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(' ')}`)
    .join('\n');
  return (sys ? `System: ${sys}\n\n` : '') + convo;
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function main() {
  const pool = new Pool(loadAccounts(ACCOUNTS_FILE));
  console.log(`[pool] loaded ${pool.size()} account(s) from ${ACCOUNTS_FILE}`);

  let busy = Promise.resolve();
  const serialize = (fn) => {
    const next = busy.then(fn, fn);
    busy = next.catch(() => {});
    return next;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/health')) {
        return json(res, 200, { ok: true, accounts: pool.size(), healthy: pool.healthy().length, model: MODEL_ID });
      }
      if (req.method === 'GET' && req.url.startsWith('/pool')) {
        return json(res, 200, { accounts: pool.stats() });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        return json(res, 200, {
          object: 'list',
          data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'wajo' }],
        });
      }
      if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
        const body = await readBody(req);
        const prompt = lastUserText(body.messages || []) || buildPrompt(body.messages || []);
        if (!prompt) return json(res, 400, { error: { message: 'no user message' } });
        const stream = !!body.stream;
        const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;

        const result = await serialize(() => runWithFailover(pool, prompt));

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify(chunk(id, result.text, null))}\n\n`);
          res.write(`data: ${JSON.stringify(chunk(id, '', 'stop'))}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          json(res, 200, {
            id,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
        return;
      }
      json(res, 404, { error: { message: 'not found' } });
    } catch (e) {
      const msg = String(e.message || e);
      if (!res.headersSent) json(res, 500, { error: { message: msg } });
      else res.end();
    }
  });

  server.listen(PORT, HOST, () => console.log(`[pool] listening on http://${HOST}:${PORT}/v1`));
}

function chunk(id, content, finish) {
  return {
    id,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
  };
}

/** Try each account once until one completes a run. */
async function runWithFailover(pool, prompt, attempts = null) {
  const tries = attempts || pool.size();
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const acct = pool.pick();
    try {
      const { text, sessionId } = await acct.client.run(prompt, { sessionId: acct.sessionId });
      acct.sessionId = sessionId;
      acct.ok++;
      return { text, account: acct.raw.email || null };
    } catch (e) {
      acct.fail++;
      acct.cooldownUntil = Date.now() + COOLDOWN_MS;
      if (acct.client.cookies.wajo_refresh) {
        await acct.client.refresh().catch(() => {});
      }
      lastErr = e;
    }
  }
  throw lastErr || new Error('no accounts available');
}

main();
