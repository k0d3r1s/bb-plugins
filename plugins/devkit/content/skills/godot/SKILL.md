---
name: godot
description: Use when building in Godot 4 — scenes, signals, exports, 2D, 3D, Control UI, networking, Rust extensions.
metadata:
  keywords: [multiplayer, gdextension]
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [game-dev-essentials, gdscript, rust-gdext]
---

# Godot 4

**Iron Law: scenes are composable units. Signals decouple — never call up the tree. Control nodes use anchors + containers, never absolute positioning. In networked games the server is authoritative; clients predict, server confirms. Rust GDExtensions pin `compatibility_minimum` to the matching `gdext api-*` feature or the class registers silently.**

**Versions:** Supported `4.4`, `4.5`, `4.6` · Current `4.6` · Next `4.7` — _Forward+ default renderer; compositor effects; new physics interpolation; per-pixel transparency on Wayland; Jolt physics integration deepens in 4.6+._

## Scene system — composition over inheritance

A _scene_ is a tree of nodes saved as `.tscn` — the unit of reuse, version control, loading. A good scene exposes a small surface (`@export` vars, signals, a couple of public methods); internals stay private.

**Instancing** is the most powerful refactoring tool — edit the `.tscn` once, every instance updates:

```gdscript
const ENEMY_SCENE := preload("res://scenes/enemy/enemy.tscn")
var enemy := ENEMY_SCENE.instantiate() as Enemy
add_child(enemy)
```

**Scene inheritance** couples children to base. **Prefer composition** (export a `Weapon` resource, instance a `Weapon` child).

| Want                                   | Choice                                   |
| -------------------------------------- | ---------------------------------------- |
| Reused 2+ places, or edited standalone | New scene                                |
| Shared sub-behavior across entities    | Component child node (Health, Movement)  |
| Single use, 5 nodes                    | Inline                                   |
| Rotate around offset                   | `Pivot` Node2D between parent and sprite |
| Deep tree (12+ levels)                 | Flatten via groups or `%NodeName`        |

`get_tree()` returns the SceneTree singleton (not the root node) — manages ticks, pausing, group calls, scene loading: `get_tree().paused = true`, `change_scene_to_file(...)`, `call_group("enemies", "freeze")`.

## Signals — connection patterns

Signal declaration + emit + `await` patterns live in `Skill(gdscript)`. Godot-specific connection conventions:

| Style                          | Use when                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| Editor connection              | Wire-up-once (UI buttons, scene-level)                          |
| Code connection (`.connect()`) | Gameplay — visible in code review and grep                      |
| `await emitter.signal`         | One-shot sequences (cutscenes, dialog)                          |
| EventBus autoload              | **Truly global** events (death, save, scene change)             |
| Resource signals               | Shared data drives multiple nodes (Health on HUD + AI + shader) |

**Don't route Player→HUD through EventBus.** Use the bus for cross-cutting; sibling-via-parent for local. Auto-disconnects when either node frees. Manual disconnect only when a short-lived node connects to a long-lived autoload — do it in `_exit_tree`.

## @export — inspector ergonomics

```gdscript
@export var speed: float = 200.0
@export_range(0.0, 1.0) var volume: float = 0.8
@export_range(0, 100, 1) var hp: int = 100
@export_enum("Easy", "Normal", "Hard") var difficulty
@export_file("*.json") var config_path: String
@export_multiline var description: String
@export var target: Node2D                                # drag-and-drop ref
@export var enemies: Array[Enemy] = []
@export var stats: WeaponStats                            # Resource
@export var weapon_scene: PackedScene
```

`WeaponStats extends Resource` with exported fields — designers create `sword.tres`, drag into the slot. **Shared refs:** mutating `stats.damage` at runtime hits all wielders — call `stats = stats.duplicate()` in `_ready` for per-instance state.

Use `@export_group("Movement")` / `@export_subgroup("Defense")` / `@export_category("Debug")` to break a 30-field inspector into a usable one.

| `@export`                      | autoload                             | `const`                                   |
| ------------------------------ | ------------------------------------ | ----------------------------------------- |
| Per-instance, designer-tunable | Global state (score, settings, save) | Same value, every instance, never changes |

## 2D — Node2D essentials

| Class                               | Use for                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `Sprite2D` / `AnimatedSprite2D`     | Static / frame-by-frame                               |
| `AnimationPlayer`                   | Keyframe any property — cutscenes, camera shake       |
| `Camera2D`                          | `enabled = true` to activate; smoothing, zoom, limits |
| `TileMapLayer` (4.3+)               | One layer per visual depth                            |
| `ParallaxBackground` / `Parallax2D` | Scrolling backdrops                                   |
| `CanvasLayer` / `CanvasModulate`    | HUD above camera; global tint                         |
| `Light2D`, `LightOccluder2D`        | 2D lighting + shadows                                 |

**Z-ordering:** CanvasLayer > z_index > tree order. Top-down/iso: `y_sort_enabled = true` on parent → children draw by global Y. **Pixel art:** texture Filter = Nearest; project default = Nearest; font filter = Nearest. `round(global_position)` if jitter.

## 3D — pick renderer at project start

| Renderer                      | Use for                                          |
| ----------------------------- | ------------------------------------------------ |
| **Forward+** (Vulkan)         | Default desktop. Many lights, decals, fog, SDFGI |
| **Mobile** (Vulkan)           | iOS/Android — fewer features, cheaper            |
| **Compatibility** (OpenGL ES) | Old hardware, web (WebGL2)                       |

**Switch only at project start** — shaders + material features differ. **Coord system:** Y-up, -Z forward (right-handed); orient models forward = -Z.

**Lighting:** `DirectionalLight3D` (sun, cascaded shadows — 2-split fast, 4-split better far); `OmniLight3D` bulbs; `SpotLight3D` flashlights. Limit shadow-casting lights in view. **Environment:** one `WorldEnvironment` per scene; reusable `Environment.tres`. SDFGI (real-time, ~2-4 ms) for dynamic; LightmapGI (baked) faster + sharper for static. **Materials:** `StandardMaterial3D` PBR; `ShaderMaterial` custom. `set_surface_override_material` per-instance; else edit shared.

## Control / UI — anchors + containers

Every Control has 4 anchors (0.0-1.0 along parent edges); offsets are pixel distances. Use editor **presets** — Full Rect (fills + scales), Top Wide (stretches across top), Center (fixed size centered), Bottom Right (sticky corner). **Children of a Container ignore their own anchors** — the container positions them.

| Container                             | Layout                         |
| ------------------------------------- | ------------------------------ |
| `VBoxContainer` / `HBoxContainer`     | Vertical / horizontal stack    |
| `GridContainer`                       | N-column grid                  |
| `MarginContainer` / `CenterContainer` | One child + margins / centered |
| `AspectRatioContainer`                | Maintains aspect               |
| `TabContainer` / `ScrollContainer`    | Tabs / scrollbars on overflow  |

Use `size_flags_horizontal = SIZE_EXPAND_FILL` + `stretch_ratio`. `custom_minimum_size` so buttons don't shrink below readable. **Themes:** `Theme` resource centralizes colors, fonts, stylebox borders. Set on top-level Control → cascades. **Responsive:** anchors that stretch + containers for reflow; Project Settings → Display → Stretch Mode = `canvas_items`, Aspect = `expand`. Test at 1280×720, 1920×1080, 2560×1440, mobile portrait. **mouse_filter:** `STOP` (default, eats event) / `PASS` / `IGNORE`. Buttons unclickable = a transparent ancestor with `STOP` is eating events.

## Networking (high-level multiplayer)

Built on ENet (or WebSocket/WebRTC). Node-based replication: nodes have an authority peer, RPCs run on remote peers, `MultiplayerSpawner` / `MultiplayerSynchronizer` automate spawning and state sync.

**Server is authoritative — never trust the client.** Server validates damage taken, items picked up, position deltas (snap-back on impossible moves), action cooldowns. Authority gate every write: `if not is_multiplayer_authority(): return`. RPCs marked `@rpc("any_peer", ...)` MUST validate `multiplayer.get_remote_sender_id() == get_multiplayer_authority()` AND range-check numeric inputs — otherwise a malicious peer spawns bullets from another player's position.

| Topology                          | Use when                           |
| --------------------------------- | ---------------------------------- |
| Client-server (Godot default)     | Most games — one source of truth   |
| Listen server (one player hosts)  | Casual co-op                       |
| Peer-to-peer                      | Fighting games, deterministic sims |
| Dedicated server (headless Godot) | Competitive games                  |

Lag compensation: client-side prediction (own input) + entity interpolation (remote players rendered ~100 ms in the past) + lag-compensated hit detection on server. Slow-paced games (RTS, card) skip all this — just RPC the actions.

Full networking workflow (peer setup, authority deep-dive, RPC annotation slots, `MultiplayerSpawner`/`Synchronizer` config, transport tradeoffs, lag compensation patterns, common pitfalls): `references/godot-multiplayer.md`.

## Rust GDExtension

Compiled Rust libraries register as Godot classes via the `gdext` crate. **`compatibility_minimum` in the `.gdextension` manifest must match the Godot minor the `gdext` crate was built against** — mismatched manifests fail silently (editor logs nothing useful, class doesn't register). Bundle `.gdextension` + per-platform compiled libraries inside the exported project; players never know it's an extension.

```ini
# godot-project/mygame.gdextension
[configuration]
entry_symbol            = "gdext_rust_init"
compatibility_minimum   = 4.5
reloadable              = true

[libraries]
linux.release.x86_64    = "res://../rust/target/release/libmygame_rust.so"
macos.release           = "res://../rust/target/release/libmygame_rust.dylib"
windows.release.x86_64  = "res://../rust/target/release/mygame_rust.dll"
```

Always add an empty `.gdignore` in `target/` and the Rust crate root so Godot doesn't import-scan build artifacts. **Never** `RUSTFLAGS=-C target-cpu=native` for release builds — the binary uses instructions only your dev CPU has; use `target-cpu=x86-64-v2` for a modern baseline instead.

Full GDExtension packaging workflow (cross-compile matrix, `cargo-make` build coordination, hot-reload caveats, CI matrix, distribution paths, common gotchas table): `references/godot-rust-extension.md`. For the Rust binding code (`#[derive(GodotClass)]`, `#[func]`, `Gd<T>`, lifecycle hooks): `Skill(rust-gdext)`.

## Anti-patterns

- God scene (entire game inline in `main.tscn`)
- Hard-coded sibling paths (`$"../../UI/HealthBar"`) — use `%HealthBar` or signals
- Inheritance for variation (12 inherited scenes each tweaking one field) — use exports
- Instancing in `_init` (nodes don't exist yet) — use `_ready` or call-deferred
- Forgetting `queue_free` — removed instances leak
- Child reaches up (`get_parent().score += 1`) — emit `score_gained(amount)`
- Imperative signal names (`kill_player`) — should be facts (`player_died`)
- EventBus for local signals (only global events)
- Hardcoded `position.x = 1820` instead of anchors
- Drag-positioning a Control inside a Container
- Forgot `CanvasLayer` for UI → scrolls with camera
- Pixel-art font with default Linear filter → fuzzy mess
- Trusting the client in multiplayer — server validates everything
- Heavy `_process` on non-authority — non-authority should mostly render
- Same scene on server + client with `is_server()` branches everywhere — split server-only logic into separate nodes added only on server
- RPC every frame for continuous state — use `MultiplayerSynchronizer`
- Authority set after `add_child` — first physics tick wrong; set before
- `target-cpu=native` in `[profile.release]` of a Rust GDExtension — binary crashes on user CPUs missing those instructions
- One giant `.gdextension` for multiple unrelated tools — split per concern

## Hand-off

For GDScript syntax + APIs + lifecycle + signal declaration + perf cheatsheet: `Skill(gdscript)`. For engine-agnostic game architecture (ECS, state machines, fixed timestep, asset pipelines, physics, audio): `Skill(game-dev-essentials)`. For the Rust binding code itself: `Skill(rust-gdext)`. For full multiplayer workflow: `references/godot-multiplayer.md`. For Rust GDExtension packaging + cross-compile + CI: `references/godot-rust-extension.md`.
