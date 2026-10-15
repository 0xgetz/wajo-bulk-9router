# wajo·bulk·9router

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a.svg?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-111.svg?style=flat-square)](#)
[![9Router](https://img.shields.io/badge/9Router-openai--compatible-6d28d9.svg?style=flat-square)](https://9router.com)
[![Wajo](https://img.shields.io/badge/Wajo-wajo.ai-4f46e5.svg?style=flat-square)](https://wajo.ai)
[![PRs](https://img.shields.io/badge/PRs-welcome-22c55e.svg?style=flat-square)](#)

**批量创建 [Wajo AI](https://wajo.ai) 账号，并将它们统一为一个
OpenAI 兼容端点在 [9Router](https://9router.com) 上提供服务** —— 账号间轮询、
自动故障转移，无需浏览器。

```
9Router /v1  ──▶  adapter :8783  ──▶  accounts.jsonl  ──▶  agent.api.wajo.ai
   (wajo/fo)        轮询 + 故障转移      N 个已采集会话      Fo 智能体
```

## 为什么

Wajo 提供 **Fo** 智能体，但其后端并非公开的 LLM API —— 客户端调用的是同源 SSR
服务端函数，且原始网关会拒绝来自数据中心 IP 的重放。本工具**逆向工程了登录与
智能体 REST 接口**（见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)），并通过纯 HTTPS
复现整个生命周期：注册、获取会话 Cookie、运行智能体，再经 9Router 暴露给任意
OpenAI 客户端。

## 特性

- **批量账号** — 邮箱（mail.tm）→ 邮件验证码 → Firebase 换取 → 会话 Cookie，全自动。
- **无需浏览器** — 纯 HTTPS；可横向扩展，每个 IP 一个进程。
- **账号池** — 轮询选取、每账号独立会话、冷却 + 故障转移、Cookie 刷新。
- **OpenAI 兼容** — `/v1/models` 与 `/v1/chat/completions`（流式 + 非流式）。
- **9Router 就绪** — 一条命令即可将适配器注册为 `openai-compatible` provider-node。
- **零依赖** — 仅使用 Node 内置模块（`https`、`crypto`、`fs`）。

## 模型可用性

Wajo 隐藏了底层 LLM —— 由服务端选择，且 API **不暴露**（`/v1/publicAgents`
返回 `model: null`、`provider: null`）。可寻址的是智能体及其套餐等级：

| 模型 id   | 智能体 | Handle | 等级徽标 | 说明                                    |
|-----------|--------|--------|----------|-----------------------------------------|
| `wajo/fo` | **Fo** | `fo`   | Mini     | Wajo 执行型智能体；唯一的公开智能体     |

可在 `src/adapter.js`（`MODELS`）中添加更多智能体别名。语音、电话与人工升级
功能存在于平台中，但**不在**此处暴露的 LLM/聊天接口之内。

> 新账号观察到的等级标签：**Mini**（套餐等级 `micro`）。更高等级改变计费/配额，
> 而非模型 id。

## 快速开始

```bash
git clone https://github.com/<you>/wajo-bulk-9router
cd wajo-bulk-9router

# 1. 批量创建账号（写入 accounts.jsonl）
node src/cli.js create --count 5

# 2. 启动账号池适配器
node src/adapter.js            # http://127.0.0.1:8783/v1

# 3. 注册到运行中的 9Router
node src/cli.js connect --router http://127.0.0.1:20128 --password 123456

# 4. 通过路由器使用
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" -H 'Content-Type: application/json' \
  -d '{"model":"wajo/fo","messages":[{"role":"user","content":"帮我预约理发"}]}'
```

### CLI

| 命令 | 用途 |
|------|------|
| `create --count N [--domain D] [--accounts FILE]` | 批量创建账号到 `accounts.jsonl` |
| `connect --router URL --password PW [--prefix wajo]` | 将适配器注册为 9Router provider-node |
| `chat --message "…" [--accounts FILE]` | 用某个账号单次回复 |
| `verify [--accounts FILE]` | 对每个账号各跑一次并报告通过/失败 |
| `serve [--port N]` | 启动 OpenAI 兼容账号池 |
| `models --router URL --key sk-…` | 列出路由器上的 `wajo/*` 模型 |

### 连接 9router.com

```bash
node src/cli.js connect --router https://9router.com --password '<密码>' \
  --adapter-url http://<host>:8783/v1
```

## 端点（适配器）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 可用的 `wajo/*` 模型 |
| POST | `/v1/chat/completions` | 聊天，`stream:true` 或不流式 |
| GET | `/health` | `{ ok, accounts, healthy, model }` |
| GET | `/pool` | 每账号健康、会话、ok/fail 计数 |

## 工作原理

1. **注册** — `POST login.wajo.ai/email-otp/start` → 轮询邮箱 → `email-otp/verify` → `customToken` → Firebase `signInWithCustomToken` → `POST /auth/callback` 设置 `wajo_token` + `wajo_refresh`。
2. **会话** — `POST agent.api.wajo.ai/v1/agents/{id}/sessions:generateId`（随机 UUID 会被拒绝）。
3. **运行** — `POST /v1/sessions/{id}:run { chatMessage, orgId }` 流式输出帧；助手文本 = `agentText` 增量 + `textFinal`。
4. **服务** — 适配器将其转换为 OpenAI `chat.completion(.chunk)`。

完整协议说明：[`docs/PROTOCOL.md`](docs/PROTOCOL.md)。目录结构：[`STRUCTURE.md`](STRUCTURE.md)。

## 要求

- Node.js **≥ 18**。
- 可接收 `POST` 的邮箱 —— [mail.tm](https://mail.tm) 开箱即用。
- 运行中的 9Router（`:20128`）或托管实例。

## 法律

仅供**教育与互操作性研究**。Wajo 的服务条款适用；使用方式由你负责。批量创建
账号可能违反其条款 —— 请谨慎并自行承担风险。

## 许可证

[MIT](LICENSE) © 贡献者
