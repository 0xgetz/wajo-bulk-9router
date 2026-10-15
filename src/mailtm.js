'use strict';

/**
 * mail.tm inbox helper (zero-dependency).
 *
 * Wajo signup only needs mailbox possession (a 6-digit code). mail.tm gives
 * free, disposable, API-driven inboxes with no signup, so it is the default
 * provider. Any provider works via the pluggable GenericInbox shape:
 *   create() -> { address }
 *   waitForCode({ timeoutMs, since }) -> "123456" | null
 */

const https = require('https');
const { randomBytes } = require('crypto');

const MAILTM = 'https://api.mail.tm';

function httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method,
        headers: {
          accept: 'application/json',
          'user-agent': 'wajo-bulk-9router/1.0',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            /* leave null */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('mail request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function rand(n = 10) {
  return randomBytes(n).toString('hex').slice(0, n);
}

class MailTmInbox {
  constructor({ domain = null, tag = 'wb' } = {}) {
    this.domain = domain;
    this.tag = tag;
    this.address = null;
    this.password = null;
    this.token = null;
    this.accountId = null;
  }

  static async domains() {
    const r = await httpJson(`${MAILTM}/domains`);
    const list = Array.isArray(r.json) ? r.json : (r.json && r.json['hydra:member']) || [];
    return list.filter((m) => m && m.isActive && !m.isPrivate).map((m) => m.domain);
  }

  async create() {
    const domains = this.domain ? [this.domain] : await MailTmInbox.domains();
    const domain = domains[0];
    if (!domain) throw new Error('mail.tm: no active domain available');
    this.address = `${this.tag}${rand(12)}@${domain}`;
    this.password = `Wj${rand(10)}!x`;
    const r = await httpJson(`${MAILTM}/accounts`, {
      method: 'POST',
      body: { address: this.address, password: this.password },
    });
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`mail.tm create failed: ${r.status} ${r.raw.slice(0, 160)}`);
    }
    this.accountId = r.json && r.json.id;
    const t = await httpJson(`${MAILTM}/token`, {
      method: 'POST',
      body: { address: this.address, password: this.password },
    });
    if (t.status !== 200 || !t.json || !t.json.token) {
      throw new Error(`mail.tm token failed: ${t.status} ${t.raw.slice(0, 160)}`);
    }
    this.token = t.json.token;
    return { address: this.address, password: this.password, id: this.accountId };
  }

  async messages() {
    if (!this.token) throw new Error('inbox not created');
    const r = await httpJson(`${MAILTM}/messages`, { headers: { authorization: `Bearer ${this.token}` } });
    const list = Array.isArray(r.json) ? r.json : (r.json && r.json['hydra:member']) || [];
    return list;
  }

  async message(id) {
    const r = await httpJson(`${MAILTM}/messages/${id}`, { headers: { authorization: `Bearer ${this.token}` } });
    return r.json || {};
  }

  /**
   * Poll for a 6-digit verification code. Matches the first numeric code that
   * is not a known noise value, preferring a Wajo sender when present.
   */
  async waitForCode({ timeoutMs = 120000, intervalMs = 4000, since = 0, preferSender = /wajo/i } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let list = [];
      try {
        list = await this.messages();
      } catch {
        /* transient; retry */
      }
      if (list.length) {
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const preferred =
          list.find((m) => preferSender.test((m.from && m.from.address) || '')) || list[0];
        const full = await this.message(preferred.id).catch(() => null);
        const blob = full ? `${full.text || ''} ${JSON.stringify(full.html || '')}` : '';
        const codes = (blob.match(/\b\d{6}\b/g) || []).filter((c) => !/^(171717|000000|123456|111111)$/.test(c));
        const code = codes[0] || null;
        if (code) return code;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }
}

/** Reusable random-address factory when the caller only needs an address. */
function randomLocalPart(tag = 'wb', n = 12) {
  return `${tag}${rand(n)}`;
}

module.exports = { MailTmInbox, randomLocalPart, httpJson, MAILTM };
