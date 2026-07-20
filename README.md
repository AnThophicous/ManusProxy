# ManusProxy v0.2

Proxy OpenAI-compatible para **Manus** com:

- SSE stream (`chat.completions` + `responses`)
- Multi-conta + **vault criptografado** (AES-256-GCM)
- `/v1/responses` com `previous_response_id` / `last_response_id` / `session_id`
- **Reuso de sessão Manus** (não reenvia histórico → economiza tokens)
- Imagens `data:image/...;base64,...`
- Tool calls OpenAI-style

Porta default: **3010**

---

## Setup

```bash
cd ManusProxy
npm install
copy .env.example .env
```

Opcional no `.env`:

```env
MANUS_STORE_SECRET=uma-frase-longa-secreta
API_KEY=
PORT=3010
BROWSER=chrome
```

---

## Login (multi-conta)

```bash
# conta default
npm run login:chrome

# segunda conta
npm run login -- --account=trabalho --browser=chrome
```

Profiles: `manus_profiles/<id>/`  
Vault: `manus_profiles/accounts.vault.json` (criptografado)  
Chave: `MANUS_STORE_SECRET` ou auto `manus_profiles/.store_key`

---

## Subir

```bash
npm start
```

| Route | Descrição |
|-------|-----------|
| `GET /health` | status, contas, features |
| `GET /v1/models` | models |
| `POST /v1/chat/completions` | chat (+ stream, tools, images, session_id) |
| `POST /v1/responses` | Responses API |
| `GET/DELETE /v1/responses/:id` | store |
| `GET /v1/accounts` | multi-conta |
| `POST /v1/accounts` | cria id |
| `POST /v1/accounts/default` | set default |

Header de conta: `x-manus-account: trabalho`

---

## Responses API — economia de tokens

```json
// 1) primeira mensagem
POST /v1/responses
{
  "model": "manus-chat",
  "input": "Lembre que meu nome é Elaine",
  "session_id": "conv-1"
}

// → response.id = resp_xxx, session_id, Manus session interna

// 2) follow-up — SÓ o turno novo vai pro Manus (join_session)
POST /v1/responses
{
  "model": "manus-chat",
  "input": "Qual é meu nome?",
  "previous_response_id": "resp_xxx"
}
```

Aliases: `last_response_id` ≡ `previous_response_id`.

Também funciona em chat:

```json
{
  "model": "manus-chat",
  "session_id": "<manus_session_from_previous>",
  "messages": [{ "role": "user", "content": "continua" }]
}
```

---

## Stream SSE

```json
{ "model": "manus-chat", "stream": true, "messages": [...] }
```

### Thinking / reasoning da Manus

Capturado de `chatDelta.delta.thought` (e aliases) e exposto no stream:

**Chat Completions SSE**
```json
{
  "choices": [{
    "delta": {
      "reasoning_content": "…pensamento…",
      "reasoning": "…pensamento…"
    }
  }]
}
```
No final (non-stream): `message.reasoning_content` + `message.reasoning`.

**Responses SSE**
- `response.reasoning_summary_text.delta`
- `manus.thinking.delta` (alias)
- item `type: "reasoning"` no `output` final

---

## Imagens (data URL)

```json
{
  "model": "manus-chat",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "O que tem na imagem?" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBOR..." } }
    ]
  }]
}
```

---

## Tool calls

Envie `tools` no formato OpenAI. O proxy instrui a Manus a emitir:

```xml
<tool_call>
{"name":"get_weather","arguments":{"city":"SP"}}
</tool_call>
```

Resposta volta com `finish_reason: "tool_calls"` e `message.tool_calls[]`.  
Mande de volta `role: "tool"` + `tool_call_id` **na mesma session** (`previous_response_id` ou `session_id`).

---

## Aguardando resposta humana (HITL)

Quando o agente Manus **pausa e espera você** (confirmar, escolher, digitar):

| API | Sinal |
|-----|--------|
| `/v1/responses` | `status: "incomplete"`, `incomplete_details.reason: "awaiting_user_input"` |
| stream | evento `manus.requires_input` + depois `response.incomplete` |
| chat | `requires_action: true` + `requires_action_detail` |

**Como continuar:** mande a resposta do usuário na **mesma cadeia**:

```json
POST /v1/responses
{
  "model": "manus-agent",
  "previous_response_id": "resp_xxx",
  "input": "Sim, pode seguir com a opção 2"
}
```

A sessão Manus é reaberta com `join_session` — sem reenviar o histórico inteiro.

---

## Cancelar stream / run

### 1) Cliente fecha a conexão (AbortController / fechar SSE)
- Proxy detecta `onAbort`
- Emite `stop` no WebSocket Manus
- Encerra com `cancelled` (não 500)

### 2) Cancel explícito por id

```bash
# enquanto o stream roda, o id é resp_… ou chatcmpl-…
curl.exe -X POST http://localhost:3010/v1/responses/resp_XXX/cancel
```

```bash
GET /v1/runs/active   # lista gerações em voo
```

| Ação | Efeito |
|------|--------|
| `POST …/cancel` | abort local + stop Manus |
| disconnect SSE | idem |
| `DELETE /v1/responses/:id` | cancela se ativo + apaga store |

---

## Segurança

| Item | Como |
|------|------|
| Metadata de contas | AES-256-GCM vault |
| Response store disk | AES-256-GCM |
| Browser profiles | isolados por conta |
| Logs | JWT redacted; e-mail mascarado na API |

**Não commite** `manus_profiles/`, `.store_key`, `*.vault.json`.

---

## Arquitetura

```
Cliente ──► Hono /v1/*
              │
              ├─ account vault (AES)
              ├─ response store (session continuity)
              ├─ Playwright profile (JWT fresco)
              └─ Socket.IO wss://api.manus.im
                   join_session? + user_message
                   (text / image / tools)
```
