'use strict';

/**
 * 9Router connector.
 *
 * Registers the Wajo adapter (or the per-account accounts themselves) into a
 * running 9Router instance as an `openai-compatible` provider-node, and mints a
 * router client key. 9Router API used (local, authed by the router password):
 *
 *   POST /api/auth/login      { password }                       -> session cookie
 *   POST /api/provider-nodes  { name, type, prefix, baseUrl, apiType } -> node
 *   POST /api/providers       { provider:<nodeId>, apiKey, name, priority, defaultModel }
 *   POST /api/keys            { name }                            -> sk-… client key
 *
 * GOTCHA: `provider` in POST /api/providers must be the node ID
 * (`openai-compatible-chat-<uuid>`), not the prefix, or 9Router replies
 * "Invalid provider".
 *
 * Target: https://9router.com (a hosted instance) accepts the same API; pass
 * its base URL and password. Locally, 9Router listens on :20128.
 */

const UA = 'wajo-bulk-9router/1.0';

async function login(base, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ password: password ?? '123456' }),
  });
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { ok: res.ok, cookie, body: (await res.text()).slice(0, 200) };
}

async function apiCall(base, cookie, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 400) };
}

async function ensureProviderNode(base, cookie, { name, prefix, baseUrl }) {
  const list = await apiCall(base, cookie, '/api/provider-nodes');
  const nodes = (list.json && (list.json.nodes || list.json.data)) || [];
  const existing = nodes.find((n) => n.name === name || n.prefix === prefix);
  if (existing) return { node: existing, created: false };
  const created = await apiCall(base, cookie, '/api/provider-nodes', {
    method: 'POST',
    body: JSON.stringify({ name, prefix, apiType: 'chat', type: 'openai-compatible', baseUrl }),
  });
  if (!created.ok) throw new Error(`create provider-node failed ${created.status}: ${created.text}`);
  return { node: created.json.node || created.json, created: true };
}

async function ensureConnection(base, cookie, { nodeId, name, apiKey, defaultModel }) {
  const list = await apiCall(base, cookie, '/api/providers');
  const conns = (list.json && (list.json.connections || list.json.data)) || [];
  const existing = conns.find((c) => c.provider === nodeId && c.name === name);
  if (existing) return { connection: existing, created: false };
  const created = await apiCall(base, cookie, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ provider: nodeId, apiKey, name, priority: 1, defaultModel: defaultModel || null }),
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`create connection failed ${created.status}: ${created.text}`);
  }
  return { connection: created.json && (created.json.connection || created.json), created: true };
}

async function ensureClientKey(base, cookie, name = 'wajo') {
  const list = await apiCall(base, cookie, '/api/keys');
  const keys = (list.json && (list.json.keys || list.json.data)) || [];
  const existing = keys.find((k) => k.name === name && k.isActive !== false);
  if (existing) return existing.key;
  const created = await apiCall(base, cookie, '/api/keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!created.ok) throw new Error(`create client key failed ${created.status}: ${created.text}`);
  return created.json.key;
}

/**
 * Connect the Wajo adapter to 9Router.
 * @returns {Promise<{clientKey,nodeId,connectionId,baseUrl}>}
 */
async function connect({
  base = 'http://127.0.0.1:20128',
  password = '123456',
  adapterUrl = 'http://127.0.0.1:8783/v1',
  apiKey = 'wajo-adapter',
  name = 'Wajo AI',
  prefix = 'wajo',
  defaultModel = 'wajo/fo',
  clientKeyName = 'wajo',
} = {}) {
  const { cookie, ok, body } = await login(base, password);
  if (!ok && !/already|success|ok|exist/i.test(body)) throw new Error(`9Router login failed: ${body}`);
  const { node } = await ensureProviderNode(base, cookie, { name, prefix, baseUrl: adapterUrl });
  const nodeId = node.id || node.nodeId || (node.node && node.node.id);
  const { connection } = await ensureConnection(base, cookie, { nodeId, name, apiKey, defaultModel });
  const clientKey = await ensureClientKey(base, cookie, clientKeyName);
  return {
    clientKey,
    nodeId,
    connectionId: connection && (connection.id || connection.connectionId),
    baseUrl: `${base}/v1`,
  };
}

async function listRouterModels(base, clientKey, { filter = 'wajo/' } = {}) {
  const res = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${clientKey}`, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`router /v1/models -> ${res.status}`);
  const data = await res.json();
  const ids = (data.data || []).map((m) => m.id);
  return filter ? ids.filter((id) => id.includes(filter)) : ids;
}

module.exports = {
  login,
  apiCall,
  ensureProviderNode,
  ensureConnection,
  ensureClientKey,
  connect,
  listRouterModels,
  UA,
};
