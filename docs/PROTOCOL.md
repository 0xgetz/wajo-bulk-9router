# Protocol

Wire-level notes for the Wajo (wajo.ai) login and inference surfaces, as observed
on **15 Oct 2026**. Wajo is a TanStack Start app; the browser normally talks to a
same-origin SSR server function (`POST /_serverFn/<sha256>`), but the **login** and
**agent** REST backends are plain HTTPS and reachable directly — which is what this
toolkit uses.

## 1. Login (`https://login.wajo.ai`)

### 1.1 Start an e-mail OTP (also creates the account)

```http
POST /email-otp/start
Content-Type: application/json

{
  "email": "you@inbox.tld",
  "inviteCode": "",
  "returnTo": "https://wajo.ai/fo",
  "signup": true,
  "password": "AtLeast8Chars"
}
```

```json
{ "accepted": true, "deliveryBlocked": false, "retryAfterSeconds": 0, "inviteCodeRejection": "" }
```

`deliveryBlocked: true` means the address/domain is refused — use another inbox.
A 6-digit code is e-mailed; it expires in 10 minutes and is single-use.

### 1.2 Verify the code

```http
POST /email-otp/verify
Content-Type: application/json

{ "email": "you@inbox.tld", "code": "399612", "returnTo": "https://wajo.ai/fo",
  "signup": true, "password": "AtLeast8Chars" }
```

```json
{ "customToken": "<firebase custom token>" }
```

### 1.3 Exchange the Firebase custom token

The Firebase Web API key is public in the login bundle (`__env.js` / `app.js`):
`AIzaSyDBSRcra-726bb44A7dO40QP4NiL7eAIA0`.

```http
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=<API_KEY>
Content-Type: application/json

{ "token": "<customToken>", "returnSecureToken": true }
```

```json
{ "localId": "…", "idToken": "…", "refreshToken": "…", "expiresIn": "3600" }
```

### 1.4 Establish the Wajo session

```http
POST /auth/callback
Content-Type: application/json

{
  "idToken": "<idToken>", "email": "you@inbox.tld", "refreshToken": "<refreshToken>",
  "returnTo": "https://wajo.ai/fo", "idpIdToken": "", "idpProviderId": "",
  "demoCoupon": "", "posthogDistinctId": "", "posthogHandoffDistinctId": "", "codeChallenge": ""
}
```

Response sets cookies:

| Cookie           | Flags            | TTL   | Purpose                       |
|------------------|------------------|-------|-------------------------------|
| `wajo_token`     | httpOnly, secure | ~1 h  | EdDSA JWT session             |
| `wajo_refresh`   | httpOnly, secure | ~90 d | rotate the session            |
| `wajo_registered`| secure           | ~90 d | non-sensitive marker          |

```json
{ "createdUser": true, "ok": true, "returnTo": "https://wajo.ai/fo", "userId": "…" }
```

### 1.5 Refresh

```http
POST /auth/refresh
{ "refreshToken": "<wajo_refresh>" }   -> rotated Set-Cookie
```

## 2. Inference (`https://agent.api.wajo.ai`)

A gRPC-gateway that speaks JSON. Auth: send the cookie jar, or
`Authorization: Bearer <wajo_token>`. Codes: `16` unauthenticated, `7` restricted
account, `5` not found, `3` invalid argument, `12` method not allowed.

### 2.1 Mint a session id

Session ids must be **server-generated**; a random UUID is rejected by `:run`.

```http
POST /v1/agents/{agentId}/sessions:generateId

{ "agentId": "803df601-94a8-4935-91a5-e1a1efa2cb0d" }
-> { "sessionId": "…", "agentId": "…", "sessionName": "" }
```

The public default agent is `Fo` (handle `fo`).

### 2.2 Run a message (streaming)

```http
POST /v1/sessions/{sessionId}:run
Accept: text/event-stream
Content-Type: application/json

{ "chatMessage": "Find me a barber open on Sunday", "orgId": "…" }
```

> `chatMessage` is a **string**. Sending an object yields
> `proto: invalid value for string field chatMessage`. Exactly one of
> `chatMessage` / `toolInputs` is required.

The body is newline-delimited JSON; each line wraps a `result` frame:

```json
{"result":{"sessionId":"…","streamCursor":"1792047960500-0","userMessage":{"text":"…","author":"user"}}}
```

Observed frame kinds (one key besides `sessionId`/`streamCursor`):

| Key              | Meaning                                             |
|------------------|-----------------------------------------------------|
| `started`        | run accepted (`AGENT_RUN_STATUS_RUNNING`)           |
| `userMessage`    | echo of the user turn                               |
| `reset`          | context reset for the new turn                      |
| `agentState`     | `AGENT_STATE_WORKING` / `AGENT_STATE_DONE`          |
| `agentActivity`  | human-readable status line (`.line`)                |
| `agentText`      | assistant **delta** (`.text`)                       |
| `textFinal`      | assistant **final** text (`.text`)                  |
| `runDone`        | `AGENT_RUN_STATUS_COMPLETED`                        |

Assistant text = concatenate `agentText.text`, then take `textFinal.text`.

### 2.3 Other reads

| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/sessions:recent` | `{ sessions, pinnedSessions, nextPageToken }` |
| GET | `/v1/publicAgents`    | public agent list (currently just `Fo`) |
| GET | `/v1/agentHandles/fo` | resolve an agent by handle |
| GET | `/v1/me/agent-credits`| credit balance |
| GET | `/v1/runs:mine`       | your runs |

## 3. Notes on the model

Wajo does **not** expose the underlying LLM. `/v1/publicAgents` returns
`"model": null`, `"provider": null` — routing is server-side. The user-visible
label is the agent name **Fo** and a plan-tier badge (**Mini** on the free/micro
tier). Treat `wajo/fo` as the single addressable model.

## 4. Getting to the surface (why no browser)

The SSR `/_serverFn/*` proxy 403s non-browser clients and the `agent.api` write
endpoints bind to the browser session, but the **login** flow and the
**agent REST** endpoints above accept the harvested cookies over plain HTTPS from
a normal host. That is what makes bulk provisioning practical.
