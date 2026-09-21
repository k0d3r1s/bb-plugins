---
name: rust-cli
description: Use when building a Rust CLI — clap derive, subcommands, reqwest, dialoguer prompts, anyhow vs thiserror, bundled assets, XDG paths.
metadata:
  added: 2026-05-23
  last_reviewed: 2026-05-23
  type: language
  languages: [rust]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-23"
  related: [rust-essentials, rust-async-tokio, go-cobra]
---

# Rust CLI

**Iron Law: parse with clap derive, never hand-roll `std::env::args`. `main` returns `ExitCode` and propagates errors up — no `unwrap()`/`expect()` on user-facing paths, no `dialoguer` prompt without a TTY guard, no blocking `reqwest` inside an async runtime. Config lives in XDG dirs, not the CWD.**

**Versions:** clap `4.x` · reqwest `0.12.x` · dialoguer `0.11.x` · is-terminal `0.4` · directories `5` · include*dir `0.7` — \_all on edition 2024. Pin minors in `Cargo.toml`; clap 4's derive API is stable.*

## Why clap derive (vs structopt, argh, lexopt, pico-args)

| Crate             | Verdict                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| **clap (derive)** | de-facto standard — subcommand tree, env fallback, `--help`/`--version`, completions. Pick this. |
| **structopt**     | merged into clap 4's derive years ago — do not start new crates on it                            |
| **argh / lexopt** | tiny, zero-magic; fine for a 2-flag tool with no subcommands                                     |
| **pico-args**     | minimal allocation; you write your own help text — rarely worth it                               |

Reach for clap when the CLI grows subcommands or needs generated help/completions.

## Command tree (derive API)

```rust
use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Debug, Parser)]
#[command(name = "myapp", version, about = "Operator's daily driver")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,

    /// Auto-confirm prompts. Also honored via MYAPP_YES=1.
    #[arg(long, short = 'y', global = true, env = "MYAPP_YES")]
    pub yes: bool,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sync state with the remote.
    #[command(visible_aliases = ["s", "sync"])]
    Sync {
        target: String,                              // required positional
        #[arg(long, default_value_t = 3)]            // typed default
        retries: u32,
        #[arg(long, value_enum, default_value_t = Format::Json)]
        format: Format,
        #[arg(long, value_parser = clap::value_parser!(PathBuf))]
        out: Option<PathBuf>,                        // optional → Option<T>
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format { Json, Yaml, Toml }                 // --format json|yaml|toml
```

`fn main() -> ExitCode` parses then dispatches; clap handles `--help`/`--version` and exits 2 on bad args:

```rust
fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("myapp: {e:#}"); ExitCode::FAILURE }
    }
}
```

Optional subcommand → `command: Option<Command>` and treat `None` as the default action. `#[arg(global = true)]` hangs a flag off root and every descendant.

## Args, flags, env, defaults

| You want                     | Derive attribute                                              |
| ---------------------------- | ------------------------------------------------------------- |
| Required positional          | `field: String`                                               |
| Optional positional          | `field: Option<String>`                                       |
| Repeated positional          | `field: Vec<String>`                                          |
| Bool flag                    | `#[arg(long, short = 'v')] verbose: bool`                     |
| Typed default                | `#[arg(long, default_value_t = 3)]`                           |
| Env fallback                 | `#[arg(long, env = "MYAPP_TOKEN")]`                           |
| Constrained choice           | `#[arg(value_enum)]` on a `ValueEnum` type                    |
| Custom parse                 | `#[arg(value_parser = parse_duration)]`                       |
| Trailing args (pass-through) | `#[arg(trailing_var_arg = true, allow_hyphen_values = true)]` |

**`env =` is an injection surface** — anyone who sets `MYAPP_TOKEN` overrides the flag. Use it for non-sensitive toggles; for credentials prefer an explicit `--token-file` reading from a path you control, never a bare value-in-env.

## reqwest 0.12 — pick blocking XOR async, never mix

```rust
// Cargo.toml: reqwest = { version = "0.12", default-features = false,
//   features = ["blocking", "rustls-tls", "gzip", "json"] }
let client = reqwest::blocking::Client::builder()
    .timeout(std::time::Duration::from_secs(30))     // ALWAYS set a timeout
    .user_agent(concat!("myapp/", env!("CARGO_PKG_VERSION")))
    .build()?;
let cfg: Config = client.get(url).send()?.error_for_status()?.json()?;
```

`rustls-tls` over the OpenSSL default — no system C dependency, fully static binaries. `error_for_status()` turns 4xx/5xx into an `Err` (a raw `send()` does not). The **blocking client must not run inside a Tokio runtime** — it spins its own and will panic. If your CLI already has a runtime, use `reqwest::Client` (async) and `.await`; see `Skill(k0d3:rust-async-tokio)`.

## dialoguer 0.11 — guard every prompt with a TTY check

```rust
use is_terminal::IsTerminal;

fn confirm(msg: &str, yes: bool) -> anyhow::Result<bool> {
    if yes { return Ok(true); }                       // --yes / env override
    if std::env::var_os("CI").is_some()               // pipelines set CI=true
        || !std::io::stderr().is_terminal() {         // piped / redirected
        return Ok(false);                             // never block on stdin
    }
    Ok(dialoguer::Confirm::new().with_prompt(msg).default(true).interact()?)
}
```

| Prompt                   | Use                           |
| ------------------------ | ----------------------------- |
| `Confirm`                | yes/no with a default         |
| `Input::<String>`        | free text, optional validator |
| `Select` / `MultiSelect` | pick from a list              |
| `Password`               | hidden input (no echo)        |

An unguarded `.interact()` hangs forever when stdin is piped or in CI — the most common way a Rust CLI deadlocks a pipeline. Always short-circuit on `--yes`, `CI`, and a non-TTY before prompting.

## Errors: anyhow (app) vs thiserror (lib)

The CLI binary uses `anyhow::Result<T>` with `.context(...)`; the `*-core` library crate exposes a typed `thiserror` enum callers can match. `?` bridges them because anyhow absorbs any `Error`. This is the same split as `Skill(k0d3:rust-essentials)` — load it for the full error model.

```rust
// core lib
#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("missing config key: {0}")] MissingKey(String),
    #[error(transparent)] Io(#[from] std::io::Error),
}
// cli binary
fn run(cli: Cli) -> anyhow::Result<()> {
    let cfg = core::load().context("loading config")?;   // CoreError → anyhow
    Ok(())
}
```

## Bundled assets — include_dir

```rust
use include_dir::{include_dir, Dir};
static TEMPLATES: Dir = include_dir!("$CARGO_MANIFEST_DIR/templates");

let f = TEMPLATES.get_file("app/main.rs").expect("template baked into binary");
std::fs::write(&dest, f.contents())?;                 // contents() is &[u8]
```

Templates ship inside the binary — no install step, no `data_dir` lookup at runtime. `expect` here is fine: a missing baked-in file is a build bug, not a user error.

## XDG paths — directories

```rust
let dirs = directories::ProjectDirs::from("com", "valksor", "myapp")
    .ok_or_else(|| anyhow::anyhow!("cannot resolve home directory"))?;
dirs.config_dir();   // ~/.config/myapp      (read config here)
dirs.data_dir();     // ~/.local/share/myapp (state, downloaded tools)
dirs.cache_dir();    // ~/.cache/myapp       (disposable)
```

Read config from XDG, not the CWD — a tool that reads `./config.toml` does different things depending on where it's invoked. Honor an explicit `$MYAPP_CONFIG` / `--config` override for tests and power users.

## Workspace layout

```
myapp/
├── Cargo.toml          # [workspace] resolver = "3", members = ["crates/*"]
└── crates/
    ├── myapp-cli/       # thin binary: clap, dialoguer, reqwest, ExitCode
    │   └── src/{main.rs, cli.rs, runners/*.rs}
    └── myapp-core/      # pure lib: types, parsing, thiserror — no I/O magic
```

Keep `main.rs` to parse-then-dispatch; put logic in `*-core` so it's unit-testable without spawning the binary. The CLI crate is the only place clap/dialoguer/reqwest appear. Inherit `version`/`edition`/lints via `[workspace.package]` and `[workspace.lints]`.

## Anti-patterns

- `.unwrap()`/`.expect()` on a path, network call, or parse the user controls — each is a panic with a useless backtrace. Return `Result`.
- `reqwest::blocking` inside an async runtime — it builds its own runtime and panics ("cannot start a runtime from within a runtime").
- `dialoguer` prompt with no TTY/CI/`--yes` guard — hangs forever on piped stdin or in CI.
- Hand-rolling arg parsing off `std::env::args()` — no help, no `--version`, no completions, fragile.
- `Box<dyn Error>` as the library error type — callers can't match it; use `thiserror`. Diagnostics go to stderr (`eprintln!`), not stdout.

## Red flags

| Thought                              | Reality                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| "I'll just `args().nth(1)`"          | No help, no validation, no completions. clap derive is 10 lines.           |
| "blocking reqwest is simpler"        | True — until it's inside Tokio, then it panics. Pick one model per binary. |
| "prompt is fine, who pipes a CLI?"   | CI does, every time. An unguarded prompt is a hung pipeline.               |
| "config in the working dir is handy" | Same command, different dir, different behavior — a debugging nightmare.   |
| "`unwrap()` here can't fail"         | On user input it can and will; the panic message tells them nothing.       |

## Hand-off

Ownership, errors, traits, Cargo workspaces: `Skill(k0d3:rust-essentials)`. Async client, runtime, cancellation: `Skill(k0d3:rust-async-tokio)`. The Go parallel (Cobra command tree, Viper config): `Skill(k0d3:go-cobra)`.
