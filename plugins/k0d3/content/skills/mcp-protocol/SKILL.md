---
name: mcp-protocol
description: Use when designing MCP servers/clients across languages — JSON-RPC envelope, capability negotiation, tools/resources/prompts, transports, errors.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: protocol
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [go-mcp, security, observability-essentials]
---

# MCP Protocol Fundamentals

**Iron Law: MCP is JSON-RPC 2.0 with capability negotiation. The three primitives are tools (model-controlled), resources (URI-addressable data), prompts (user-controlled templates). Tool failures return as ERROR CONTENT, not as protocol errors. Long-running tools MUST respect cancellation. Pin to a specific `protocolVersion` (current GA: `2025-03-26`) and reject mismatches at `initialize` — silent version drift produces silent bugs.**

## What MCP is

MCP (Model Context Protocol) is an open spec for how an AI client (host, e.g., Claude Desktop, an IDE) talks to context providers (servers) so the model can use tools, read data, and run user templates. Born at Anthropic, language-agnostic, SDKs in TS / Python / Go / Rust / others.

## Wire format

Every message is a **JSON-RPC 2.0** object:

```jsonc
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
  "params": { "name": "search", "arguments": { "query": "...", "limit": 10 } } }

{ "jsonrpc": "2.0", "id": 7, "result": { "content": [...], "isError": false } }

{ "jsonrpc": "2.0", "id": 7, "error": { "code": -32602, "message": "invalid params" } }
```

| Field                         | Notes                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `jsonrpc`                     | always `"2.0"`                                                                              |
| `id`                          | request matches response by id; notifications omit id                                       |
| `method`                      | namespaced (`initialize`, `tools/call`, `resources/read`, `prompts/get`, `notifications/*`) |
| `params` / `result` / `error` | per spec                                                                                    |

Error codes follow JSON-RPC: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal. **Reserve these for protocol-level faults** — tool execution failures are not protocol errors (see below).

## Capability negotiation handshake

```
Client → initialize { protocolVersion: "2025-03-26", capabilities, clientInfo }
Server → initialize result { protocolVersion: "2025-03-26", capabilities, serverInfo }
Client → notifications/initialized   (no response)
```

The server's `capabilities` declares what it supports: `tools`, `resources` (with optional `subscribe`, `listChanged`), `prompts`, `logging`. The client uses this to decide which `*/list` and `*/call` methods to invoke. **Never assume a capability** — feature-gate every call.

**`protocolVersion` mismatch handling**: if the client and server disagree, the server should respond with its supported version in the `initialize` result and the client should either re-initialize at that version or abort. Do NOT silently proceed at the client's requested version when the server cannot honor it — schema differences across versions (especially around `content` types and progress notifications) cause field-not-found errors deep in tool execution.

## The three primitives

| Primitive    | Controller              | Typical use                                                                       |
| ------------ | ----------------------- | --------------------------------------------------------------------------------- |
| **Tool**     | model decides when      | actions with side effects (DB write, send email), on-demand fetch, computation    |
| **Resource** | client/user attaches    | URI-addressable data the model reads (`file://`, `db://orders/42`, `https://...`) |
| **Prompt**   | user explicitly invokes | parameterized templates the user triggers (slash-commands, "review this PR")      |

| Tool vs Resource vs Prompt              |              |
| --------------------------------------- | ------------ |
| "Run something and return text" →       | **tool**     |
| "Make X readable by the model" →        | **resource** |
| "Let the user kick off Y from a menu" → | **prompt**   |

Wrong choice: a search action as a resource (model can't trigger it), or a system status dashboard as a tool (no need for model gating). Get this right at design time.

## Tools — error contract

```jsonc
// Success
{ "result": { "content": [ {"type": "text", "text": "..."} ], "isError": false } }

// Tool execution failure (validation, downstream API down, etc.)
{ "result": { "content": [ {"type": "text", "text": "search failed: timeout"} ], "isError": true } }

// Protocol error (method missing, bad params shape)
{ "error": { "code": -32602, "message": "missing 'query'" } }
```

**The model can recover from `isError: true` content** (it reads the message, tries different args). It cannot recover from a JSON-RPC `error` — the session aborts or retries blindly. Map your application errors to `isError: true`.

### Tool inputs need a constrained JSON Schema

```jsonc
// tools/list result — every tool MUST publish inputSchema
{
  "name": "search",
  "description": "Full-text search of the issue tracker",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false, // reject unknown keys
    "required": ["query"],
    "properties": {
      "query": { "type": "string", "minLength": 1, "maxLength": 200 },
      "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 10 },
      "status": { "type": "string", "enum": ["open", "closed", "any"], "default": "any" },
    },
  },
}
```

Validate every incoming `tools/call` argument server-side (`jsonschema` in Python, `ajv` in TS, `santhosh-tekuri/jsonschema` v6 in Go — the older `xeipuuv/gojsonschema` is unmaintained). Clients lie. `additionalProperties: false` catches typos; `enum` and numeric bounds let the model self-correct. Caveat: some MCP hosts inject `_meta`-prefixed fields into `arguments`; strip them before validation or whitelist `_meta` as an allowed extra property.

## Resources

```jsonc
// resources/list
{
  "result": {
    "resources": [
      { "uri": "config://app/settings", "name": "Settings", "mimeType": "application/json" },
      { "uri": "file:///tmp/data.csv", "name": "Latest Export", "mimeType": "text/csv" },
    ],
  },
}

// resources/read → content with uri + mimeType + (text | blob:base64)
```

MIME type is non-optional in practice — clients route on it (render markdown, parse JSON, show as image). For dynamic URIs, expose `resources/templates/list` with URI templates (`db://orders/{id}`).

## Prompts

```jsonc
// prompts/list → { name, description, arguments: [{name, required, description}] }
// prompts/get { name, arguments } → { messages: [ {role, content}, ... ] }
```

Prompts return a `messages[]` array the client injects into the conversation. Use for: code review, summarization, structured Q&A — anywhere the user wants a templated kickoff rather than free-form.

## Transports

| Transport                          | When                                          | Notes                                                                                                    |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **stdio**                          | desktop/IDE clients (Claude Desktop, plugins) | newline-delimited JSON on stdin/stdout; **NEVER write logs to stdout** — corrupts the stream; use stderr |
| **SSE** (deprecated since 2025-03) | browser, push                                 | server → client SSE channel + client → server HTTP POST; superseded by Streamable HTTP                   |
| **Streamable HTTP**                | modern remote servers                         | single endpoint, supports request-response and server-initiated push, auth via standard HTTP headers     |

stdio is the default and simplest — no auth surface, lifecycle tied to the client. Pick HTTP when you need remote access or multi-client.

## Notifications

Server → client (no id, no response):

| Notification                           | Use                                                  |
| -------------------------------------- | ---------------------------------------------------- |
| `notifications/tools/list_changed`     | tools available changed; client should re-list       |
| `notifications/resources/list_changed` | likewise for resources                               |
| `notifications/resources/updated`      | a subscribed resource changed                        |
| `notifications/message`                | structured log message (level, logger, data)         |
| `notifications/progress`               | progress on a long-running operation (token + value) |

Client → server: `notifications/cancelled` (request id) tells the server to abort. Long tools MUST honor it.

## Cancellation contract

If a tool takes > 1s: plumb cancellation to every downstream call (DB, HTTP, subprocess). On cancel, return `isError: true` with a "cancelled" message OR drop the response if the request is already cancelled. Hanging tools = hanging sessions.

## Anti-patterns

- Returning a JSON-RPC `error` for tool failures — model can't recover; use `isError: true` content
- Logging to stdout in stdio transport — JSON-RPC stream corruption, instant disconnect
- Resources without MIME types — clients can't render or route
- Tools without input schemas (or with `"type": "object"` blank) — model passes garbage, you 500
- Assuming a capability the server didn't declare — gate every call by capabilities
- Blocking tools without cancellation — first cancel = stuck session = restart
- Embedding secrets in resource URIs (`db://user:pass@host`) — they appear in client logs
- **Path-traversal in resource URIs**: `file:///{user_input}` lets a client read `/etc/passwd` if you concat without checks. Resolve symlinks first (`os.path.realpath` in Python; `filepath.EvalSymlinks` in Go — NOT `filepath.Clean`, which is purely lexical), THEN verify the result is under an allowed root (`os.path.commonpath`; `strings.HasPrefix` after `EvalSymlinks`). A `Clean`+`HasPrefix` check alone is bypassed by a symlink under the root that points outside it.
- Mixing "this is a tool but really a resource" — the model invokes the wrong one; design intent matters
- Returning gigantic content blobs (multi-MB) — pagination + URI handoff is the answer
- One MCP server doing 50 unrelated things — split by domain so capability lists stay small

## Red flags

| Thought                                                 | Reality                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| "Return the Go/Python error, the client will handle it" | No. Map to `isError: true` content.                                                   |
| "I'll log to stdout, simpler"                           | Just broke the entire protocol on stdio transport                                     |
| "The model can figure out the args"                     | Schema is the contract; constrain inputs (enum, min/max, required) — fewer recoveries |
| "We don't need cancellation, it's a quick query"        | "Quick" depends on the day; cancellation is a 5-line guarantee                        |

## Hand-off

For the Go implementation (mark3labs/mcp-go): `Skill(go-mcp)`. For securing remote MCP endpoints (auth, transport TLS, rate limits): `Skill(security)`. For structured server logging via the `notifications/message` channel: `Skill(observability-essentials)`.
