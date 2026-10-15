# wajo·bulk·9router

<img src="brand/logo.svg" alt="wajo-bulk-9router" width="520">

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a.svg?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-111.svg?style=flat-square)](#)
[![9Router](https://img.shields.io/badge/9Router-openai--compatible-6d28d9.svg?style=flat-square)](https://9router.com)
[![Wajo](https://img.shields.io/badge/Wajo-wajo.ai-4f46e5.svg?style=flat-square)](https://wajo.ai)
[![PRs](https://img.shields.io/badge/PRs-welcome-22c55e.svg?style=flat-square)](#)
[![Languages](https://img.shields.io/badge/readme-en%20%7C%20id%20%7C%20zh%20%7C%20ja%20%7C%20es-0ea5e9.svg?style=flat-square)](#readme)

**Bulk-create [Wajo AI](https://wajo.ai) accounts and serve them as one
OpenAI-compatible endpoint on [9Router](https://9router.com)** — round-robin
across accounts, automatic failover, no browser required.

```
9Router /v1  ──▶  adapter :8783  ──▶  accounts.jsonl  ──▶  agent.api.wajo.ai
   (wajo/fo)        round-robin        N harvested          Fo agent runs
                    + failover         sessions
```

---

## Why

Wajo ships the **Fo** agent, but its backend isn't a public LLM API — the client
talks to same-origin SSR server functions, and the raw gateway rejects datacenter
replays. This toolkit **reverse-engineered the login + agent REST surfaces** (see
[`docs/PROTOCOL.md`](docs/PROTOCOL.md)) and reproduces the whole lifecycle over
plain HTTPS: sign up, mint session cookies, run the agent, and expose it to any
OpenAI client through 9Router.

## Features

- **Bulk accounts** — mailbox (mail.tm) → e-mail OTP → Firebase exchange → session cookies, fully automated.
- **No browser** — pure HTTPS; scales horizontally, one process per IP.
- **Account pool** — round-robin selection, per-account sessions, cooldown + failover, cookie refresh.
- **OpenAI-compatible** — `/v1/models` and `/v1/chat/completions` (stream + non-stream).
- **9Router ready** — one command registers the adapter as an `openai-compatible` provider-node.
- **Zero dependencies** — Node built-ins only (`https`, `crypto`, `fs`).

## Availability of models

Wajo abstracts the underlying LLM — it is chosen server-side and **not exposed**
by the API (`/v1/publicAgents` returns `model: null`, `provider: null`). What is
addressable is the agent and its plan tier:

| Model id      | Agent          | Handle | Tier badge | Notes                                             |
|---------------|----------------|--------|------------|---------------------------------------------------|
| `wajo/fo`     | **Fo**         | `fo`   | Mini       | The Wajo action agent; the single public agent    |

Additional agent aliases can be added in `src/adapter.js` (`MODELS`) — the pool
routes every model id to the same agent unless a mapping is provided. Voice,
phone and human-escalation features exist on the platform but are **outside the
LLM/chat surface** exposed here.

> Tier label observed on a fresh account: **Mini** (plan tier `micro`). Higher
> tiers change billing/quota, not the model id.

## Quick start

```bash
git clone https://github.com/<you>/wajo-bulk-9router
cd wajo-bulk-9router

# 1. bulk-create accounts (writes accounts.jsonl)
node src/cli.js create --count 5

# 2. start the pool adapter
node src/adapter.js            # http://127.0.0.1:8783/v1

# 3. register it in a running 9Router
node src/cli.js connect --router http://127.0.0.1:20128 --password 123456

# 4. use it through the router
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" -H 'Content-Type: application/json' \
  -d '{"model":"wajo/fo","messages":[{"role":"user","content":"Book me a haircut"}]}'
```

### CLI

| Command | Purpose |
|---------|---------|
| `create --count N [--domain D] [--accounts FILE]` | Bulk-create accounts into `accounts.jsonl` |
| `connect --router URL --password PW [--prefix wajo]` | Register the adapter as a 9Router provider-node |
| `chat --message "…" [--accounts FILE]` | One-shot reply from an account |
| `verify [--accounts FILE]` | Run one turn on every account and report pass/fail |
| `serve [--port N]` | Start the OpenAI-compatible pool |
| `models --router URL --key sk-…` | List `wajo/*` models on the router |

### Connecting to 9router.com

`connect` targets any 9Router instance. For the hosted service pass its base URL
and password:

```bash
node src/cli.js connect --router https://9router.com --password '<your-password>' \
  --adapter-url http://<host>:8783/v1
```

## Endpoints (adapter)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | Available `wajo/*` models |
| POST | `/v1/chat/completions` | Chat, `stream:true` or not |
| GET | `/health` | `{ ok, accounts, healthy, model }` |
| GET | `/pool` | Per-account health, sessions, ok/fail counts |

## How it works

1. **Signup** — `POST login.wajo.ai/email-otp/start` → poll inbox → `email-otp/verify` → `customToken` → Firebase `signInWithCustomToken` → `POST /auth/callback` sets `wajo_token` + `wajo_refresh`.
2. **Session** — `POST agent.api.wajo.ai/v1/agents/{id}/sessions:generateId` (a random UUID is rejected).
3. **Run** — `POST /v1/sessions/{id}:run { chatMessage, orgId }` streams frames; assistant text = `agentText` deltas + `textFinal`.
4. **Serve** — the adapter turns that into OpenAI `chat.completion(.chunk)`.

Full wire notes: [`docs/PROTOCOL.md`](docs/PROTOCOL.md). Layout: [`STRUCTURE.md`](STRUCTURE.md).

## Requirements

- Node.js **≥ 18** (global `fetch` is used by the 9Router connector).
- An inbox the mailbox `POST` accepts — [mail.tm](https://mail.tm) works out of the box.
- A running 9Router (`:20128`) or a hosted instance.

## Env

| Variable | Default | Used by |
|----------|---------|---------|
| `PORT` | `8783` | adapter listen port |
| `HOST` | `127.0.0.1` | adapter bind host |
| `ACCOUNTS_FILE` | `./accounts.jsonl` | pool source |
| `WAJO_MODEL` | `wajo/fo` | advertised model id |
| `COOLDOWN_MS` | `60000` | failover cooldown |
| `ROUTER_URL` / `ROUTER_PASSWORD` / `ROUTER_KEY` | — | 9Router CLI |

## Legal

Provided for **educational and interoperability research**. Wajo's Terms apply to
their service; you are responsible for how you use it. Creating bulk accounts may
violate those Terms — use responsibly and at your own risk.

## License

[MIT](LICENSE) © contributors
