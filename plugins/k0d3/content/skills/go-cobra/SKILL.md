---
name: go-cobra
description: Use when building Go CLIs with Cobra — command tree, flags, validation, persistent flags, completions, Viper integration.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [go]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [go-essentials, go-testing, go-slog, rust-cli]
---

# Go Cobra

**Iron Law: one binary, one command tree. Every `cobra.Command` defines `RunE` (not `Run`), validates args with a typed `Args` validator, and never calls `os.Exit` — return errors and let `Execute()` surface them.**

**Versions:** Current `v1.10.x` · No LTS series — _Cobra is stable; pin the minor version in `go.mod`. Companion `cobra-cli` scaffolding tool is published separately._

## Why Cobra (vs urfave/cli, kong, stdlib `flag`)

| Library           | Verdict                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **cobra**         | de-facto Go CLI standard — kubectl, hugo, gh, docker. Subcommand tree, persistent flags, completions, Viper-native. Heaviest. |
| **urfave/cli**    | smaller API, action-based; fine for ≤10 commands and no shell completion needs                                                |
| **kong**          | struct-tagged parsing, very ergonomic; trades runtime flexibility for compile-time wiring                                     |
| **stdlib `flag`** | one binary, one or two flags only — no subcommands                                                                            |

Pick cobra when the CLI will grow subcommands and needs shell completion.

## Command tree skeleton

```go
// cmd/root.go
var rootCmd = &cobra.Command{
    Use:           "myapp",
    Short:         "Operator's daily driver",
    SilenceUsage:  true,   // don't dump --help on every error
    SilenceErrors: true,   // we print errors ourselves below
}

func Execute() {
    if err := rootCmd.ExecuteContext(context.Background()); err != nil {
        fmt.Fprintln(os.Stderr, "error:", err)
        os.Exit(1)              // exit only here, never inside RunE
    }
}

// cmd/sync.go
var syncCmd = &cobra.Command{
    Use:   "sync [target]",
    Short: "Sync state with remote",
    Args:  cobra.ExactArgs(1),
    RunE:  runSync,
}

func init() { rootCmd.AddCommand(syncCmd) }
```

One command per file under `cmd/`. `init()` is the one place it earns its keep — registering children. `ExecuteContext` propagates cancellation; pair it with `signal.NotifyContext(ctx, os.Interrupt)` in `main.go`.

## Flags: local vs persistent

| Scope              | API                                             | When                                       |
| ------------------ | ----------------------------------------------- | ------------------------------------------ |
| Local              | `cmd.Flags().StringVar(...)`                    | Only this command sees it                  |
| Persistent         | `cmd.PersistentFlags().StringVar(...)`          | This command AND every descendant inherits |
| Required           | `cmd.MarkFlagRequired("name")`                  | Cobra enforces presence before `RunE`      |
| Mutually exclusive | `cmd.MarkFlagsMutuallyExclusive("a", "b")`      | Either-or; both = error                    |
| Together           | `cmd.MarkFlagsRequiredTogether("user", "pass")` | All or none                                |

```go
var verbose bool
rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "verbose output")
syncCmd.Flags().StringVar(&target, "target", "", "remote target")
syncCmd.MarkFlagRequired("target")
```

Persistent global flags belong on root. Resist adding them anywhere else — they obscure where state comes from.

## Args validators

```go
Args: cobra.MatchAll(
    cobra.ExactArgs(1),
    func(cmd *cobra.Command, args []string) error {
        if !isValidSlug(args[0]) {
            return fmt.Errorf("invalid slug: %q", args[0])
        }
        return nil
    },
),
```

| Validator                             | Use                            |
| ------------------------------------- | ------------------------------ |
| `NoArgs`                              | Subcommand has no positionals  |
| `ExactArgs(n)`                        | Exactly n                      |
| `MinimumNArgs(n)` / `MaximumNArgs(n)` | Bounds                         |
| `RangeArgs(min, max)`                 | Both                           |
| `OnlyValidArgs`                       | Must appear in `cmd.ValidArgs` |
| `MatchAll(...)`                       | Compose multiple               |

Always set `Args:`. Default behavior accepts anything — a quick way to ship silent typo-tolerance bugs.

## Pre/post-run hooks

```go
var rootCmd = &cobra.Command{
    PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
        return setupLogger(verbose)   // runs for every subcommand
    },
    PersistentPostRunE: func(cmd *cobra.Command, args []string) error {
        return flushTelemetry()
    },
}
```

Execution order: `PersistentPreRunE` (ancestors first) → `PreRunE` → `RunE` → `PostRunE` → `PersistentPostRunE` (ancestors last). Use `PersistentPreRunE` for logger init, config load, auth bootstrap.

## Viper integration (config-file + env-var fallback)

```go
import "github.com/spf13/viper"

func initConfig() {
    viper.SetConfigName("config")          // looks for config.yaml/json/toml
    viper.AddConfigPath("$HOME/.myapp")
    viper.AutomaticEnv()                   // MYAPP_TARGET → --target
    viper.SetEnvPrefix("myapp")
    viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))

    if err := viper.ReadInConfig(); err != nil {
        var nf viper.ConfigFileNotFoundError
        if !errors.As(err, &nf) { cobra.CheckErr(err) }   // missing file is OK; bad file is not
    }
    // Bind every flag so precedence is: flag > env > config > default
    cobra.CheckErr(viper.BindPFlags(rootCmd.PersistentFlags()))
}

cobra.OnInitialize(initConfig)
```

`viper.GetString("target")` resolves from any source. **Always bind flags** — otherwise `--target` is silently ignored when a config file is present.

**Security — `AutomaticEnv()` is an env-injection surface**: it maps every flag (including `--config`, `--token`, `--key-file`) to `MYAPP_*` env vars. In CI / container orchestrators / parent-process chains an attacker who injects an env var overrides the flag. For credential or auth-path flags, prefer `MarkFlagRequired` (no env fallback) or explicit `BindEnv` for non-sensitive ones only — don't let `AutomaticEnv` cover everything.

## Shell completion

```go
// cmd/completion.go is auto-generated by `cobra-cli add completion` if you scaffold,
// but the runtime hook is automatic — just enable it once per user shell:

// bash:  myapp completion bash | sudo tee /etc/bash_completion.d/myapp
// zsh:   myapp completion zsh  > "${fpath[1]}/_myapp"
// fish:  myapp completion fish > ~/.config/fish/completions/myapp.fish
```

For dynamic completion (e.g., suggest slugs from a registry):

```go
cmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
    return availableSlugs(toComplete), cobra.ShellCompDirectiveNoFileComp
}
```

## Testing CLIs

```go
func TestSync(t *testing.T) {
    buf := new(bytes.Buffer)
    cmd := newRootCmd()                    // factory — never test the global rootCmd
    cmd.SetOut(buf); cmd.SetErr(buf)
    cmd.SetArgs([]string{"sync", "--target", "prod"})

    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if !strings.Contains(buf.String(), "synced prod") {
        t.Errorf("output = %q, want contains 'synced prod'", buf.String())
    }
}
```

Refactor `cmd/root.go` to expose `newRootCmd()` — a factory that builds a fresh tree per test. Global state breaks parallel tests and `go test -shuffle on`.

## Anti-patterns

- `os.Exit` inside `RunE` — `Execute()` already does the exit dance; you also break test capture
- `Run` instead of `RunE` — losing the error return swallows all failure paths
- Missing `SilenceUsage: true` — every error spews `--help`, drowning the actual message
- `cobra.CheckErr` deep inside business logic — only acceptable at startup (config init) where panic-then-exit is fine
- Persistent flags everywhere — at scale they form a global namespace; bind to the narrowest command
- Calling `viper.Get*` in `init()` — config isn't loaded yet; do it inside `RunE` or `PersistentPreRunE`
- Hand-writing completion logic — `cobra.ShellCompDirective*` is the supported path
- Testing the global `rootCmd` — flag state leaks between tests; use a factory

## Red flags

| Thought                             | Reality                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| "Just `fmt.Println` + `os.Exit(1)`" | Tests can't capture; bypasses `Execute()`'s exit logic                     |
| "Required flags enforced in RunE"   | `MarkFlagRequired` runs first with the standard error format               |
| "Viper or flags — pick one"         | They complement: flags override, Viper is the source tree                  |
| "Add completion later"              | Schema lives in the command tree — build it right and `completion` is free |

## Hand-off

Structured logging from `RunE`/`PersistentPreRunE`: `Skill(go-slog)`. Table-driven CLI tests: `Skill(go-testing)`. Go idioms, errors, modules: `Skill(go-essentials)`. Cobra + Bubble Tea: `Skill(go-bubbletea-charm)`.
