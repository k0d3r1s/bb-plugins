# Headroom

Server-side plugin. Runs a Headroom context-compression proxy with bb and points Claude
Code and Codex threads at it through bb's per-provider environment hook, replacing a
per-agent `headroom wrap`.

## How it works

- Starts `headroom proxy` on a loopback URL (default `http://127.0.0.1:8787`), reuses a
  proxy already answering there, restarts it on settings changes, and stops it on
  disable, reload, or shutdown.
- Routes a thread only when it runs on the bb server's machine and the proxy answers
  `/health`; every other thread goes direct.
- Claude Code: `ANTHROPIC_BASE_URL=<url>`, `ENABLE_TOOL_SEARCH=true`.
  Codex: `CODEX_OPENAI_BASE_URL=<url>/v1`.

## Surfaces

- Settings: `url`, `manage`, `command`, `claude`, `codex`.
- CLI: `bb headroom status [--json]`.

See `skills/headroom/SKILL.md` for details.
