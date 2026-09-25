---
name: headroom
description: Route bb's Claude Code and Codex threads through a Headroom context-compression proxy — check whether routing is active, why a thread went direct, and how to change the proxy URL or command.
---

# Headroom

The Headroom plugin runs a [Headroom](https://github.com/headroomlabs-ai/headroom) proxy
with bb and points Claude Code and Codex threads at it, so tool output and context are
compressed before they reach the model. It replaces running `headroom wrap claude` /
`headroom wrap codex` by hand for each agent.

## What it does per thread

On every start, resume, fork, and turn command the plugin contributes environment
variables to the provider — only when all of these hold:

- the provider's switch is on (`claude`, `codex`),
- the thread runs on the bb server's own machine (other enrolled machines go direct),
- the proxy answers `GET <url>/health`.

Otherwise it contributes nothing and the thread talks to its provider directly. A
proxy outage never blocks a turn.

| Provider | Variables |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=<url>`, `ENABLE_TOOL_SEARCH=true` |
| Codex | `CODEX_OPENAI_BASE_URL=<url>/v1` |

`ENABLE_TOOL_SEARCH=true` keeps Claude Code's deferred tool loading on; Claude Code
turns it off behind a custom base URL otherwise. The contributed values appear in the
thread's `provider.env-resolved` timeline event.

Codex routing needs a bb build whose Codex bridge accepts `CODEX_OPENAI_BASE_URL`
without an Account Pooler token. Older builds ignore the variable and Codex goes direct.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:8787` | Proxy root, without `/v1`. |
| `manage` | `true` | Start `headroom proxy --host <host> --port <port>` with bb and stop it on disable or shutdown. Only for loopback URLs. A proxy already answering at the URL is reused (re-checked every 30s and replaced if it goes away). |
| `command` | `headroom` | Executable used to start the proxy; set an absolute path when bb's PATH lacks it. |
| `claude` | `true` | Route Claude Code threads. |
| `codex` | `true` | Route Codex threads. |

Change them with `bb plugin config headroom set <key> <value>` or in Settings → Plugins.
A settings change restarts the managed proxy; no reload is needed.

## Commands

- `bb headroom status [--json]` — proxy URL, whether it answers, the manager state
  (`off`, `adopted`, `starting`, `running`, `invalid-url`, `not-loopback`), and which
  providers are routed.

## Troubleshooting

- **Plugin shows needs-configuration: command not found.** Install Headroom
  (`uv tool install --python 3.13 "headroom-ai[all]"` or `pip install "headroom-ai[all]"`),
  or set `command` to its absolute path, then `bb plugin reload headroom`.
- **Health says not answering while the manager is `starting`.** The proxy is still
  loading; threads go direct until it answers.
- **The service keeps restarting.** `headroom proxy` is exiting — commonly because
  another process holds the port. Its output is in the bb server log at debug level.
- **Account Pooler is also installed.** Both set `ANTHROPIC_BASE_URL`; the plugin
  registered first wins and bb logs the conflict. Use one of them per provider.
