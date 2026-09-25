# bb-plugin-headroom

Runs a [Headroom](https://github.com/headroomlabs-ai/headroom) context-compression proxy
with bb and routes Claude Code and Codex threads through it, so you do not have to launch
each agent with `headroom wrap`.

## How it works

- A background service starts `headroom proxy` on the configured loopback URL
  (default `http://127.0.0.1:8787`) and stops it when the plugin is disabled, reloaded,
  or bb shuts down. A proxy already answering there is reused.
- For each Claude Code or Codex command on the bb server's own machine, the plugin
  contributes `ANTHROPIC_BASE_URL` + `ENABLE_TOOL_SEARCH=true` (Claude Code) or
  `CODEX_OPENAI_BASE_URL=<url>/v1` (Codex) — only while the proxy answers `/health`.
  Otherwise the thread goes direct, so a proxy outage never blocks a turn.
- Threads on other enrolled machines are not routed.
- It changes no provider configuration files.

Codex routing needs a bb build whose Codex bridge accepts `CODEX_OPENAI_BASE_URL`
without an Account Pooler token.

## Requirements

Headroom on the bb server's machine:

```sh
uv tool install --python 3.13 "headroom-ai[all]"
```

## Surfaces

- Settings: `url`, `manage`, `command`, `claude`, `codex`.
- CLI: `bb headroom status [--json]`.

See [`skills/headroom/SKILL.md`](skills/headroom/SKILL.md) for details.
