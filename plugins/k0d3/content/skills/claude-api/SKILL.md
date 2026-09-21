---
name: claude-api
description: Use when designing against Anthropic's Messages API — model selection, prompt caching, extended thinking, tool use, batch, streaming.
metadata:
  added: 2026-05-19
  last_reviewed: 2026-05-19
  type: protocol
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-19"
  related: [llm-essentials, agent-design, mcp-protocol, go-anthropic]
---

# Claude API (Messages) — Language-Agnostic Reference

**Iron Law: every request to `/v1/messages` carries `model`, `max_tokens`, and explicit `system` + `messages`. Tool failures are reported as `tool_result` content blocks with `is_error: true` — NOT as HTTP errors. Prompt caching breakpoints are placed at _stable prefix boundaries_ (system → tools → long context → conversation tail); putting `cache_control` on a tail message defeats the cache. Pin `anthropic-version` and never read the model ID from user input.**

**Snapshot:** Current model family as of 2026-05 — Opus 4.7 (`claude-opus-4-7`), Sonnet 4.6 (`claude-sonnet-4-6`), Haiku 4.5 (`claude-haiku-4-5-20251001`). Endpoint base: `https://api.anthropic.com`. API version header: `anthropic-version: 2023-06-01` (stable). Beta features ride on `anthropic-beta` headers.

## Model matrix

| Model      | When to pick                                                      | Cost shape                                            |
| ---------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Opus 4.7   | hardest reasoning, agentic loops, ambiguity tolerance             | high $/tok; lower latency than prior Opus generations |
| Sonnet 4.6 | default workhorse — coding, RAG, structured tool use              | middle; the right answer 80% of the time              |
| Haiku 4.5  | high-volume classification, routing, summarization, fast UI calls | lowest $/tok; smallest context-fill cost              |

## Request envelope

```jsonc
POST /v1/messages
Headers:
  x-api-key: sk-ant-...
  anthropic-version: 2023-06-01
  content-type: application/json

{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "system": [ { "type":"text", "text":"You are a careful code reviewer." } ],
  "messages": [
    { "role":"user", "content":[ {"type":"text","text":"Review this diff:..."} ] }
  ],
  "temperature": 0.2,
  "stop_sequences": ["</done>"]
}
```

`system` may be a string (legacy) or an array of content blocks (preferred — enables per-block `cache_control`). `messages` alternates `user` / `assistant`; the API rejects two consecutive same-role messages. Response shape:

```jsonc
{
  "id":"msg_01...", "type":"message", "role":"assistant",
  "model":"claude-sonnet-4-6",
  "content":[ {"type":"text","text":"..."} ],
  "stop_reason":"end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal",
  "usage": { "input_tokens":345, "output_tokens":120,
             "cache_creation_input_tokens":0, "cache_read_input_tokens":0 }
}
```

`usage` is authoritative for billing — log it on every call. Cache fields appear only when caching is in play (see below).

## Prompt caching

Add `"cache_control": { "type": "ephemeral", "ttl": "5m" }` to a content block. The cache key is the **exact bytes of all content up to and including** that block, plus `model`, `system`, and `tools`. Up to 4 breakpoints per request.

```jsonc
"system":[
  { "type":"text", "text":"You are a senior engineer." },
  { "type":"text", "text":"<150KB of architecture docs ... long stable context>",
    "cache_control": { "type":"ephemeral", "ttl":"5m" } }   // breakpoint #1
],
"tools":[ ... "cache_control": { "type":"ephemeral" } ],     // breakpoint #2
"messages":[
  { "role":"user", "content":[ {"type":"text","text":"<dynamic question>"} ] }
]
```

| TTL            | When                                             | Cost note                                  |
| -------------- | ------------------------------------------------ | ------------------------------------------ |
| `5m` (default) | conversational, request-bursty workloads         | cache write costs 1.25x input; reads ~0.1x |
| `1h`           | long-lived agent loops, expensive system prompts | cache write costs 2x input; reads ~0.1x    |

**Breakpoint placement rules:**

- Put breakpoints at **stable** boundaries: end-of-system, end-of-tools, end-of-long-context. The conversation tail changes every turn — caching it is wasted.
- Cache _suffix_ of a request is whatever follows the last cached prefix; that part is always full-cost input.
- A single byte change above the breakpoint invalidates the cache. Stable serialization (sorted JSON keys, no timestamps in system prompts) is mandatory.
- Observe via `usage.cache_read_input_tokens` vs `cache_creation_input_tokens`. Reads-without-creations across runs => cache is working. Creations-without-reads => the prefix is moving.

## Extended thinking

```jsonc
{ "model":"claude-sonnet-4-6", "max_tokens":4096,
  "thinking": { "type":"enabled", "budget_tokens":2000 },
  "messages":[ ... ] }
```

Response includes `thinking` content blocks before the final `text`:

```jsonc
"content":[
  { "type":"thinking", "thinking":"Let me check the invariant...", "signature":"..." },
  { "type":"text", "text":"The race is in line 42 because..." }
]
```

`budget_tokens` is a soft cap on the thinking allotment; output_tokens beyond `budget_tokens` count toward `max_tokens`. With tool use you can opt into **interleaved thinking** (header `anthropic-beta: interleaved-thinking-2025-05-14`) so the model thinks between tool calls. **Persist `thinking` blocks verbatim across turns** — stripping them breaks the model's chain.

## Tool use

Declare tools at the request level; the model returns `tool_use` content blocks; you reply with `tool_result` content blocks.

```jsonc
"tools":[
  { "name":"search_issues",
    "description":"Full-text search of the issue tracker. Use for retrieving open bugs.",
    "input_schema": {
      "type":"object", "additionalProperties": false,
      "required":["query"],
      "properties":{
        "query":{"type":"string","minLength":1,"maxLength":200},
        "limit":{"type":"integer","minimum":1,"maximum":50,"default":10}
      } } }
],
"tool_choice": { "type":"auto" }    // or "any" | {"type":"tool","name":"..."} | {"type":"none"}
```

When `stop_reason == "tool_use"`, parse `tool_use` blocks, execute, and continue the conversation with a `user` message whose content is one or more `tool_result` blocks:

```jsonc
{ "role":"user", "content":[
  { "type":"tool_result", "tool_use_id":"toolu_01...", "content":"[...search hits...]",
    "is_error": false } ] }

// Tool execution failure — model can recover and try different args:
{ "type":"tool_result", "tool_use_id":"toolu_01...",
  "content":"timeout after 30s; try narrower query", "is_error": true }
```

**Constrain inputs with JSON Schema** (`additionalProperties:false`, enums, numeric bounds). Validate every `tool_use` server-side — clients lie, and the model passes garbage when the schema is loose. Parallel tool calls arrive as multiple `tool_use` blocks in one response; execute concurrently and reply with their results in any order in a single `user` turn.

## Streaming (SSE)

Add `"stream": true`. Response is `text/event-stream` with event types:

| Event                 | Carries                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `message_start`       | initial message envelope (id, model, empty content, usage seed)                                             |
| `content_block_start` | new block (`text`, `tool_use`, `thinking`)                                                                  |
| `content_block_delta` | `text_delta`, `input_json_delta` (tool args streaming as partial JSON), `thinking_delta`, `signature_delta` |
| `content_block_stop`  | block index complete                                                                                        |
| `message_delta`       | top-level updates: `stop_reason`, final `usage`                                                             |
| `message_stop`        | terminal event                                                                                              |
| `ping`                | keep-alive (ignore)                                                                                         |
| `error`               | mid-stream error; the connection terminates                                                                 |

Tool-call streaming: `input_json_delta` arrives as raw partial JSON strings — buffer them and parse once `content_block_stop` fires for that index. Don't try to parse partial JSON.

## Batch, Files, Citations (one-liner each)

| Feature             | Endpoint / shape                                                                                                                | Use                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Message Batches** | `POST /v1/messages/batches` with up to 100k requests; results polled async                                                      | 50% cheaper input + output; 24h SLA; not for interactive          |
| **Files**           | `POST /v1/files`; reference in `messages` content as `{type:"document", source:{type:"file", file_id:"..."}}`                   | upload PDFs / docs once, reference many times; works with caching |
| **Citations**       | tools or documents with `citations:{enabled:true}`; response carries `citations` arrays on text blocks pointing at source spans | grounded answers with source attribution                          |

For computer-use (screenshots + cursor/keyboard tools), see `anthropic-beta: computer-use-2024-10-22` and the dedicated `computer_20241022` tool type — covered in [[agent-design]].

## Rate limits + retries

Response headers carry `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`. On `429` or `5xx`:

- Honor `retry-after` header if present
- Otherwise: jittered exponential backoff, idempotent (use `Idempotency-Key` request header for transactional safety)
- Cap retries (3 is sensible); surface failures rather than burning budget on doom loops
- `400`s are permanent — schema, bad model, oversize request; do NOT retry

## Errors

```jsonc
{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }
```

`type` values: `invalid_request_error` (400), `authentication_error` (401), `permission_error` (403), `not_found_error` (404), `request_too_large` (413), `rate_limit_error` (429), `api_error` / `overloaded_error` (5xx). HTTP status maps 1:1 — drive retry logic off the type.

## Anti-patterns

- Putting `cache_control` on a message that changes every turn — zero hit rate, full write cost
- Two breakpoints inside the same monolithic system text — the second supersedes; you wasted one
- Stripping `thinking` blocks before sending the next turn — breaks the model's continuity for follow-ups
- Returning HTTP 500 for a tool failure — instead emit `tool_result` `is_error: true` so the model recovers
- `tool_choice: "any"` when you want a specific tool — forces _some_ tool but not _which_; use `{type:"tool","name":"..."}`
- Treating partial `input_json_delta` chunks as parseable JSON — buffer first, parse at `content_block_stop`
- Logging full prompts in production — system prompts hold PII / IP; redact before sink
- Pinning model to a _family alias_ (`claude-sonnet-latest`) in production — silent model swaps re-baseline evals; pin a specific version ID

## Red flags

| Thought                                                | Reality                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| "I'll cache the whole request including the user turn" | Cache key changes every call; you pay write-cost for nothing          |
| "5m TTL is always fine"                                | For an agent loop running 30+ min, 1h pays back fast                  |
| "Tool failure -> throw 500"                            | Model can't recover; use `is_error: true` content                     |
| "I'll skip `additionalProperties:false`"               | Model invents keys; validation fails downstream with no recovery path |
| "Streaming partial tool args parse with `JSON.parse`"  | Throws — buffer the deltas first                                      |

## Hand-off

For Go SDK ergonomics (client init, streaming accumulator, tool-use marshaling): [[go-anthropic]]. For provider-agnostic patterns (token economics, sampling, retry math, eval): [[llm-essentials]]. For agent-loop architecture above the API layer (memory, planning, failure modes): [[agent-design]]. If you're bridging Claude to an MCP server: [[mcp-protocol]].
