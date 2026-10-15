# Structure

```
wajo-bulk-9router
│
├── src/
│   ├── wajo.js              Wajo API client — signup (login.wajo.ai),
│   │                        Firebase exchange, /auth/callback cookie mint,
│   │                        session :generateId, streaming :run protocol
│   ├── mailtm.js            zero-dep mail.tm inbox: create, poll, extract OTP
│   ├── provision.js         one account end-to-end + retry/backoff wrapper
│   ├── adapter.js           OpenAI-compatible pool server :8783 (round-robin,
│   │                        cooldown + failover, /health, /pool)
│   ├── connect-9router.js   register adapter as a 9Router provider-node +
│   │                        connection, mint sk-… router client key
│   └── cli.js               create | connect | chat | verify | serve | models
│
├── docs/
│   └── PROTOCOL.md          wire-level notes: endpoints, cookies, run frames
│
├── brand/
│   ├── logo.svg             full wordmark
│   └── icon.svg             square app icon
│
├── README.md                English (canonical)
├── README.id.md             Bahasa Indonesia
├── README.zh.md             中文
├── README.ja.md             日本語
├── README.es.md             Español
├── STRUCTURE.md             this file
├── package.json             zero dependencies, Node >= 18
├── accounts.jsonl           created accounts (gitignored)
├── .gitignore
└── LICENSE                  MIT
```

## Data flow

```
                     ┌─────────────────────────────────────────────┐
                     │             wajo-bulk-9router               │
                     └─────────────────────────────────────────────┘

  signup            mail.tm inbox ──► 6-digit code
                       │
                       ▼
  login.wajo.ai   email-otp/start ─► email-otp/verify ─► customToken
                       │                                    │
                       ▼                                    ▼
  identitytoolkit  signInWithCustomToken ◄──────────────────┘
                       │  idToken + refreshToken
                       ▼
  login.wajo.ai   /auth/callback ─► wajo_token · wajo_refresh (cookies)
                       │
                       ▼                     accounts.jsonl
                  ┌──────────┐   append   ┌───────────────────┐
                  │ provision│───────────►│  one JSON line /  │
                  └──────────┘            │  account + cookies│
                                          └───────────────────┘
                                                    │
                                          ┌─────────┴─────────┐
                                          ▼                   ▼
                                   ┌────────────┐      ┌────────────┐
                                   │  adapter   │      │  CLI chat  │
                                   │ pool :8783 │      │  / verify  │
                                   └─────┬──────┘      └────────────┘
                                         │ round-robin + failover
                                         │ POST /v1/agents/{id}/sessions:generateId
                                         │ POST /v1/sessions/{id}:run  (SSE)
                                         ▼
                                 agent.api.wajo.ai

  9Router  ──►  POST /api/provider-nodes (openai-compatible, prefix "wajo")
            ──►  POST /api/providers      (connect adapter /v1)
            ──►  POST /api/keys           (sk-… router client key)
                       │
                       ▼
              GET  /v1/models            wajo/fo
              POST /v1/chat/completions  stream + non-stream
```

## Per-request lifecycle (adapter)

```
client ─► adapter /v1/chat/completions
            │  pick next healthy account (round-robin)
            │  reuse its Wajo session id, else :generateId
            ▼
          Wajo run(chatMessage)  ──► stream frames
            │  textFinal / agentText  ─► assistant text
            ▼
          on error ─► cooldown account + refresh cookie ─► retry next account
```
