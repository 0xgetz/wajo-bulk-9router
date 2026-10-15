'use strict';

/**
 * Account provisioner.
 *
 * Creates a Wajo account end-to-end and returns its harvested session cookies:
 *   1. mail.tm inbox
 *   2. Wajo email-otp/start  (delivers the 6-digit code)
 *   3. poll inbox for the code
 *   4. email-otp/verify -> Firebase custom token
 *   5. Firebase signInWithCustomToken -> idToken + refreshToken
 *   6. /auth/callback -> wajo_token / wajo_refresh cookies
 *
 * Everything is plain HTTPS against Wajo's public login + identity endpoints,
 * so no browser is required and it scales horizontally (one process per IP).
 */

const { WajoClient } = require('./wajo');
const { MailTmInbox } = require('./mailtm');

async function provisionAccount({
  inbox = null,
  domain = null,
  tag = 'wb',
  password = null,
  codeTimeoutMs = 150000,
  returnTo = 'https://wajo.ai/fo',
  onLog = () => {},
} = {}) {
  const box = inbox || new MailTmInbox({ domain, tag });
  if (!box.address) await box.create();
  const email = box.address;
  const pw = password || box.password;
  onLog(`inbox  ${email}`);

  const start = await WajoClient.emailOtpStart({ email, password: pw, returnTo });
  if (start.status !== 200 || start.body.accepted !== true) {
    throw new Error(`otp start rejected: ${start.status} ${JSON.stringify(start.body)}`);
  }
  if (start.body.deliveryBlocked) throw new Error('otp delivery blocked for this address');
  onLog('otp    requested');

  const code = await box.waitForCode({ timeoutMs: codeTimeoutMs });
  if (!code) throw new Error(`no verification code for ${email} within ${codeTimeoutMs}ms`);
  onLog(`otp    received (${code.slice(0, 1)}•••••)`);

  const verify = await WajoClient.emailOtpVerify({ email, password: pw, code, returnTo });
  const fb = await WajoClient.firebaseCustomTokenSignIn(verify.customToken);

  const cb = await WajoClient.authCallback({
    idToken: fb.idToken,
    refreshToken: fb.refreshToken,
    email,
    returnTo,
  });

  if (!cb.cookies.wajo_token) {
    throw new Error('signup finished but no wajo_token cookie was returned');
  }

  const client = new WajoClient({ cookies: cb.cookies });
  client.email = email;
  client.password = pw;
  client.userId = (cb.body && cb.body.userId) || null;
  client.createdAt = new Date().toISOString();
  onLog(`done   userId=${client.userId || '?'} cookies=${Object.keys(cb.cookies).join(',')}`);
  return client;
}

/** Provision with retries on transient failures (mail lag, delivery blocks). */
async function provisionWithRetry({ attempts = 3, onLog = () => {}, ...opts } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await provisionAccount({ ...opts, onLog: (m) => onLog(`[try ${i}] ${m}`) });
    } catch (e) {
      lastErr = e;
      onLog(`[try ${i}] failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

module.exports = { provisionAccount, provisionWithRetry };
