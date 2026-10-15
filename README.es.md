# wajo·bulk·9router

<img src="brand/logo.svg" alt="wajo-bulk-9router" width="520">

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a.svg?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-111.svg?style=flat-square)](#)
[![9Router](https://img.shields.io/badge/9Router-openai--compatible-6d28d9.svg?style=flat-square)](https://9router.com)
[![Wajo](https://img.shields.io/badge/Wajo-wajo.ai-4f46e5.svg?style=flat-square)](https://wajo.ai)
[![PRs](https://img.shields.io/badge/PRs-welcome-22c55e.svg?style=flat-square)](#)

**Crea cuentas de [Wajo AI](https://wajo.ai) en masa y sírvelas como un único
endpoint compatible con OpenAI en [9Router](https://9router.com)** — round-robin
entre cuentas, failover automático, sin navegador.

```
9Router /v1  ──▶  adapter :8783  ──▶  accounts.jsonl  ──▶  agent.api.wajo.ai
   (wajo/fo)        round-robin        N sesiones           agente Fo
                    + failover         recolectadas
```

## Por qué

Wajo ofrece el agente **Fo**, pero su backend no es una API LLM pública — el cliente
llama a funciones SSR del mismo origen y la pasarela sin procesar rechaza las
repeticiones desde IPs de centro de datos. Este toolkit **hizo ingeniería inversa de
las superficies REST de inicio de sesión y del agente** (ver
[`docs/PROTOCOL.md`](docs/PROTOCOL.md)) y reproduce todo el ciclo por HTTPS simple:
registro, obtención de cookies de sesión, ejecución del agente y exposición a
cualquier cliente OpenAI a través de 9Router.

## Características

- **Cuentas en masa** — buzón (mail.tm) → OTP por correo → canje Firebase → cookies de sesión, totalmente automatizado.
- **Sin navegador** — HTTPS puro; escala horizontalmente, un proceso por IP.
- **Grupo de cuentas** — selección round-robin, sesiones por cuenta, cooldown + failover, refresco de cookies.
- **Compatible con OpenAI** — `/v1/models` y `/v1/chat/completions` (stream y no-stream).
- **Listo para 9Router** — un comando registra el adaptador como provider-node `openai-compatible`.
- **Cero dependencias** — solo módulos integrados de Node (`https`, `crypto`, `fs`).

## Disponibilidad de modelos

Wajo abstrae el LLM subyacente — se elige en el servidor y **no se expone** en la API
(`/v1/publicAgents` devuelve `model: null`, `provider: null`). Lo direccionable es el
agente y su nivel de plan:

| Model id  | Agente   | Handle | Nivel | Notas                                          |
|-----------|----------|--------|-------|------------------------------------------------|
| `wajo/fo` | **Fo**   | `fo`   | Mini  | El agente de acción de Wajo; el único público  |

Se pueden añadir alias de agente en `src/adapter.js` (`MODELS`). Las funciones de voz,
teléfono y escalado a humanos existen en la plataforma pero quedan **fuera** de la
superficie LLM/chat aquí expuesta.

> Nivel observado en una cuenta nueva: **Mini** (plan `micro`). Los niveles superiores
> cambian facturación/cuota, no el id de modelo.

## Inicio rápido

```bash
git clone https://github.com/<tu>/wajo-bulk-9router
cd wajo-bulk-9router

# 1. crear cuentas en masa (escribe accounts.jsonl)
node src/cli.js create --count 5

# 2. iniciar el adaptador de grupo
node src/adapter.js            # http://127.0.0.1:8783/v1

# 3. registrarlo en un 9Router en ejecución
node src/cli.js connect --router http://127.0.0.1:20128 --password 123456

# 4. usarlo a través del router
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" -H 'Content-Type: application/json' \
  -d '{"model":"wajo/fo","messages":[{"role":"user","content":"Resérvame un corte de pelo"}]}'
```

### CLI

| Comando | Propósito |
|---------|-----------|
| `create --count N [--domain D] [--accounts FILE]` | Crear cuentas en masa en `accounts.jsonl` |
| `connect --router URL --password PW [--prefix wajo]` | Registrar el adaptador como provider-node de 9Router |
| `chat --message "…" [--accounts FILE]` | Respuesta puntual desde una cuenta |
| `verify [--accounts FILE]` | Un turno por cuenta, informe de éxito/fallo |
| `serve [--port N]` | Iniciar el grupo compatible con OpenAI |
| `models --router URL --key sk-…` | Listar modelos `wajo/*` en el router |

### Conectar a 9router.com

```bash
node src/cli.js connect --router https://9router.com --password '<tu-clave>' \
  --adapter-url http://<host>:8783/v1
```

## Endpoints (adaptador)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/v1/models` | Modelos `wajo/*` disponibles |
| POST | `/v1/chat/completions` | Chat, `stream:true` o no |
| GET | `/health` | `{ ok, accounts, healthy, model }` |
| GET | `/pool` | Salud, sesiones y conteos ok/fail por cuenta |

## Cómo funciona

1. **Registro** — `POST login.wajo.ai/email-otp/start` → sondeo del buzón → `email-otp/verify` → `customToken` → Firebase `signInWithCustomToken` → `POST /auth/callback` fija `wajo_token` + `wajo_refresh`.
2. **Sesión** — `POST agent.api.wajo.ai/v1/agents/{id}/sessions:generateId` (un UUID aleatorio es rechazado).
3. **Ejecución** — `POST /v1/sessions/{id}:run { chatMessage, orgId }` emite frames; texto del asistente = deltas `agentText` + `textFinal`.
4. **Servir** — el adaptador lo convierte en OpenAI `chat.completion(.chunk)`.

Notas completas del protocolo: [`docs/PROTOCOL.md`](docs/PROTOCOL.md). Estructura: [`STRUCTURE.md`](STRUCTURE.md).

## Requisitos

- Node.js **≥ 18**.
- Un buzón que acepte `POST` — [mail.tm](https://mail.tm) funciona sin configuración.
- Un 9Router en ejecución (`:20128`) o una instancia alojada.

## Legal

Se proporciona para **investigación educativa y de interoperabilidad**. Aplican los
Términos de Wajo; eres responsable de su uso. Crear cuentas en masa puede violarlos —
úsalo con responsabilidad y bajo tu propio riesgo.

## Licencia

[MIT](LICENSE) © colaboradores
