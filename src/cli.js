'use strict';

/**
 * Wajo × 9Router CLI.
 *
 *   create   --count N [--domain D] [--accounts FILE]   bulk-create accounts
 *   connect  [--router URL] [--password PW]              register pool in 9Router
 *   chat     --message "..." [--accounts FILE]           one-shot via an account
 *   verify   [--accounts FILE]                           run one turn on every account
 *   serve    [--port N]                                  start the pool adapter
 *   models   --router URL --key sk-…                     list wajo/* models on router
 *
 * Nothing here needs a browser: Wajo's signup (login.*) and inference
 * (agent.api.*) endpoints are plain HTTPS.
 */

const fs = require('fs');
const path = require('path');
const { provisionWithRetry } = require('./provision');
const { WajoClient } = require('./wajo');
const { connect, listRouterModels } = require('./connect-9router');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const ACCOUNTS_FILE = arg('accounts', path.join(__dirname, '..', 'accounts.jsonl'));

function appendAccount(client, file) {
  const rec = {
    email: client.email,
    userId: client.userId,
    orgId: client.orgId,
    agentId: client.agentId,
    handle: client.handle,
    cookies: client.cookies,
    createdAt: client.createdAt || new Date().toISOString(),
  };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  return rec;
}

function loadAccounts(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function cmdCreate() {
  const count = Number(arg('count', '1'));
  const domain = arg('domain', null);
  const tag = arg('tag', 'wb');
  console.log(`Creating ${count} Wajo account(s) -> ${ACCOUNTS_FILE}`);
  let made = 0;
  for (let i = 1; i <= count; i++) {
    try {
      const client = await provisionWithRetry({
        attempts: 3,
        domain,
        tag,
        onLog: (m) => console.log(`[${i}/${count}] ${m}`),
      });
      const rec = appendAccount(client, ACCOUNTS_FILE);
      made++;
      console.log(`[${i}/${count}] saved ${rec.email} (userId ${rec.userId})`);
    } catch (e) {
      console.error(`[${i}/${count}] FAILED: ${e.message}`);
    }
  }
  console.log(`\nDone: ${made}/${count} accounts created.`);
}

async function cmdConnect() {
  const base = arg('router', process.env.ROUTER_URL || 'http://127.0.0.1:20128');
  const password = arg('password', process.env.ROUTER_PASSWORD || '123456');
  const port = arg('port', process.env.PORT || '8783');
  const r = await connect({
    base,
    password,
    adapterUrl: arg('adapter-url', `http://127.0.0.1:${port}/v1`),
    prefix: arg('prefix', 'wajo'),
  });
  console.log('Connected to 9Router:');
  console.log(JSON.stringify(r, null, 2));
}

async function cmdChat() {
  const message = arg('message', 'Ping');
  const accounts = loadAccounts(ACCOUNTS_FILE);
  if (!accounts.length) throw new Error(`no accounts in ${ACCOUNTS_FILE}`);
  const a = accounts[0];
  const client = new WajoClient({ cookies: a.cookies, orgId: a.orgId, agentId: a.agentId });
  const { text } = await client.run(message);
  console.log(text);
}

async function cmdVerify() {
  const accounts = loadAccounts(ACCOUNTS_FILE);
  if (!accounts.length) throw new Error(`no accounts in ${ACCOUNTS_FILE}`);
  let ok = 0;
  for (const [i, a] of accounts.entries()) {
    const client = new WajoClient({ cookies: a.cookies, orgId: a.orgId, agentId: a.agentId });
    try {
      const { text } = await client.run('Reply with exactly: VERIFY_OK');
      const pass = /VERIFY_OK/.test(text);
      if (pass) ok++;
      console.log(`[${i + 1}/${accounts.length}] ${a.email} -> ${pass ? 'OK' : 'odd'}: ${JSON.stringify(text)}`);
    } catch (e) {
      console.log(`[${i + 1}/${accounts.length}] ${a.email} -> FAIL: ${e.message}`);
    }
  }
  console.log(`\n${ok}/${accounts.length} accounts verified.`);
}

async function cmdServe() {
  require('./adapter');
}

async function cmdModels() {
  const base = arg('router', process.env.ROUTER_URL || 'http://127.0.0.1:20128');
  const key = arg('key', process.env.ROUTER_KEY);
  if (!key) throw new Error('pass --key sk-… (9Router client key)');
  const ids = await listRouterModels(base, key);
  console.log(ids.join('\n'));
}

const commands = {
  create: cmdCreate,
  connect: cmdConnect,
  chat: cmdChat,
  verify: cmdVerify,
  serve: cmdServe,
  models: cmdModels,
};

async function main() {
  const cmd = process.argv[2];
  const fn = commands[cmd];
  if (!fn) {
    console.log('usage: cli.js <create|connect|chat|verify|serve|models> [--flags]');
    process.exit(1);
  }
  await fn();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('error:', e.message);
    process.exit(1);
  });
}

module.exports = { loadAccounts, appendAccount };
