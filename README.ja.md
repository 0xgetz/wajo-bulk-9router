# wajo·bulk·9router

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a.svg?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-111.svg?style=flat-square)](#)
[![9Router](https://img.shields.io/badge/9Router-openai--compatible-6d28d9.svg?style=flat-square)](https://9router.com)
[![Wajo](https://img.shields.io/badge/Wajo-wajo.ai-4f46e5.svg?style=flat-square)](https://wajo.ai)
[![PRs](https://img.shields.io/badge/PRs-welcome-22c55e.svg?style=flat-square)](#)

**[Wajo AI](https://wajo.ai) のアカウントを一括作成し、それらを
[9Router](https://9router.com) 上の 1 つの OpenAI 互換エンドポイントとして提供**します
— アカウント間のラウンドロビン、自動フェイルオーバー、ブラウザ不要。

```
9Router /v1  ──▶  adapter :8783  ──▶  accounts.jsonl  ──▶  agent.api.wajo.ai
   (wajo/fo)        ラウンドロビン       収集済み N セッション   Fo エージェント
                    + フェイルオーバー
```

## なぜ

Wajo は **Fo** エージェントを提供しますが、そのバックエンドは公開 LLM API では
ありません。クライアントは同一オリジンの SSR サーバー関数を呼び、生のゲートウェイは
データセンター IP からのリプレイを拒否します。本ツールキットは**ログインと
エージェント REST 面をリバースエンジニアリング**し（[`docs/PROTOCOL.md`](docs/PROTOCOL.md) 参照）、
プレーン HTTPS でライフサイクル全体を再現します。サインアップ、セッション Cookie の
取得、エージェント実行、そして 9Router 経由で任意の OpenAI クライアントへの公開。

## 特徴

- **一括アカウント** — メールボックス（mail.tm）→ メール OTP → Firebase 交換 → セッション Cookie、完全自動。
- **ブラウザ不要** — 純粋な HTTPS。水平にスケール可能、IP ごとに 1 プロセス。
- **アカウントプール** — ラウンドロビン、アカウント別セッション、クールダウン + フェイルオーバー、Cookie 更新。
- **OpenAI 互換** — `/v1/models` と `/v1/chat/completions`（ストリーム + 非ストリーム）。
- **9Router 対応** — 1 コマンドでアダプターを `openai-compatible` provider-node として登録。
- **依存ゼロ** — Node 組み込みのみ（`https`、`crypto`、`fs`）。

## モデルの可用性

Wajo は基盤 LLM を隠蔽しており、サーバー側で選択され API では**公開されません**
（`/v1/publicAgents` は `model: null`、`provider: null` を返す）。アドレス可能なのは
エージェントとプラン階層です：

| モデル id | エージェント | Handle | 階層バッジ | 備考                                    |
|-----------|--------------|--------|------------|-----------------------------------------|
| `wajo/fo` | **Fo**       | `fo`   | Mini       | Wajo の実務エージェント。唯一の公開エージェント |

追加のエージェントエイリアスは `src/adapter.js`（`MODELS`）で追加できます。音声・
電話・人間エスカレーション機能はプラットフォームに存在しますが、ここで公開する
LLM／チャット面の**外側**です。

> 新規アカウントで確認された階層ラベル：**Mini**（プラン階層 `micro`）。上位階層は
> 課金／クォータを変えるもので、モデル id は変わりません。

## クイックスタート

```bash
git clone https://github.com/<you>/wajo-bulk-9router
cd wajo-bulk-9router

# 1. アカウントを一括作成（accounts.jsonl を書き込む）
node src/cli.js create --count 5

# 2. プールアダプターを起動
node src/adapter.js            # http://127.0.0.1:8783/v1

# 3. 稼働中の 9Router に登録
node src/cli.js connect --router http://127.0.0.1:20128 --password 123456

# 4. ルーター経由で利用
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" -H 'Content-Type: application/json' \
  -d '{"model":"wajo/fo","messages":[{"role":"user","content":"散髪を予約して"}]}'
```

### CLI

| コマンド | 用途 |
|----------|------|
| `create --count N [--domain D] [--accounts FILE]` | `accounts.jsonl` にアカウントを一括作成 |
| `connect --router URL --password PW [--prefix wajo]` | アダプターを 9Router provider-node として登録 |
| `chat --message "…" [--accounts FILE]` | 1 アカウントでの単発応答 |
| `verify [--accounts FILE]` | 全アカウントで 1 ターン実行し合否を報告 |
| `serve [--port N]` | OpenAI 互換プールを起動 |
| `models --router URL --key sk-…` | ルーター上の `wajo/*` モデル一覧 |

### 9router.com への接続

```bash
node src/cli.js connect --router https://9router.com --password '<パスワード>' \
  --adapter-url http://<host>:8783/v1
```

## エンドポイント（アダプター）

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/v1/models` | 利用可能な `wajo/*` モデル |
| POST | `/v1/chat/completions` | チャット、`stream:true` または非ストリーム |
| GET | `/health` | `{ ok, accounts, healthy, model }` |
| GET | `/pool` | アカウント別の健全性、セッション、ok/fail 数 |

## 仕組み

1. **サインアップ** — `POST login.wajo.ai/email-otp/start` → 受信箱をポーリング → `email-otp/verify` → `customToken` → Firebase `signInWithCustomToken` → `POST /auth/callback` が `wajo_token` + `wajo_refresh` を設定。
2. **セッション** — `POST agent.api.wajo.ai/v1/agents/{id}/sessions:generateId`（ランダム UUID は拒否される）。
3. **実行** — `POST /v1/sessions/{id}:run { chatMessage, orgId }` がフレームをストリーム。アシスタント本文 = `agentText` 差分 + `textFinal`。
4. **提供** — アダプターが OpenAI `chat.completion(.chunk)` に変換。

完全なプロトコル： [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。構成： [`STRUCTURE.md`](STRUCTURE.md)。

## 要件

- Node.js **≥ 18**。
- `POST` を受け付ける受信箱 — [mail.tm](https://mail.tm) はすぐ使えます。
- 稼働中の 9Router（`:20128`）またはホスト型インスタンス。

## 法的事項

**教育および相互運用性研究**のために提供されます。Wajo の利用規約が適用され、使用は
自己責任です。一括アカウント作成は同規約に違反する可能性があります — 責任を持って
利用してください。

## ライセンス

[MIT](LICENSE) © コントリビューター
