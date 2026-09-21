---
name: gdscript
description: Use when writing GDScript — syntax, types, signals, lifecycle, Godot APIs, and the perf patterns that matter.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: language
  languages: [gdscript]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [godot, game-dev-essentials]
---

# GDScript

**Iron Law: type everything at function boundaries. Signals for cross-node communication — never `get_node('../../../X')`. `_physics_process` for physics, `_process` for visuals. Profile before optimizing.**

**Versions:** Supported `4.4`, `4.5`, `4.6` · Current `4.6` · Next `4.7` — _Static typing strongly recommended (perf + tooling); typed lambdas + first-class callables since 4.4; lambda captures explicit in 4.5+._

Target Godot 4.x. 3.x has different lifecycle and typing rules.

## File layout & naming

```
project/
├── project.godot
├── scenes/<feature>/<feature>.tscn + .gd     # group by feature, not by type
├── autoloads/<name>.gd                       # singletons (Project Settings → Autoload)
├── resources/                                # custom Resource data classes (.tres)
└── assets/
```

| Kind                   | Convention                                       | Example                       |
| ---------------------- | ------------------------------------------------ | ----------------------------- |
| Files / folders        | `snake_case`                                     | `player_controller.gd`        |
| Classes (`class_name`) | `PascalCase`                                     | `class_name Player`           |
| Functions / variables  | `snake_case`                                     | `func take_damage(amount)`    |
| Constants              | `UPPER_SNAKE`                                    | `const MAX_HP := 100`         |
| Signals                | `snake_case`, **past tense** (fact, not command) | `signal damaged(amount: int)` |
| Private                | leading underscore                               | `var _cached_node`            |
| Godot virtuals         | `_lowercase`                                     | `_ready`, `_process`          |

Tabs only — mixing tabs and spaces makes the parser reject the file.

## Typing — default everywhere

```gdscript
class_name Player
extends CharacterBody2D

const SPEED: float = 200.0
var hp: int = 100
@onready var sprite: Sprite2D = $Sprite2D
@onready var anim: AnimationPlayer = %Anim     # unique-name lookup
@export_range(0.0, 1.0) var volume: float = 0.5

func take_damage(amount: int, source: Node = null) -> void:
    hp -= amount
func get_neighbors() -> Array[Enemy]:
    return _neighbors
```

| Form                     | Use when                                                             |
| ------------------------ | -------------------------------------------------------------------- |
| `var x: T = expr`        | Class fields, public API — readers shouldn't chase the RHS           |
| `var x := expr`          | Locals where the type is obvious from the value                      |
| `var x = expr`           | **Never** for production code (Variant — slow + no autocomplete)     |
| `func f(a: T) -> R:`     | **Every** function — parameters AND return type                      |
| `Array[T]`               | Typed array — available since Godot 4.0                              |
| `Dictionary[K,V]` (4.4+) | Typed dictionary — Godot 4.4+; on 4.0-4.3 use `Dictionary` (untyped) |
| `as T` then null-check   | Casts can fail; `as` returns `null` instead of crashing              |

After `if x is T:`, the compiler does NOT auto-narrow — cast: `var enemy := x as Enemy`. Integer division gotcha: `1 / 2 == 0` — use `1.0 / 2` or `float(a) / b`.

## Lifecycle

| Callback                  | When                              | Use for                                     |
| ------------------------- | --------------------------------- | ------------------------------------------- |
| `_init()`                 | Construction, before tree         | Pure data init. **Don't touch other nodes** |
| `_ready()`                | Node + children ready             | **Most setup**                              |
| `_process(delta)`         | Every visual frame, variable rate | Visuals, UI                                 |
| `_physics_process(delta)` | Fixed step (60 Hz)                | Movement, collisions, physics               |
| `_exit_tree()`            | Leaving tree                      | Cleanup long-lived connections              |

**`_ready` order pitfall**: children fire `_ready` BEFORE their parent. Sibling order is NOT guaranteed. Reading `$Sibling.value` from `_ready` can silently get zero/null. Fix: `call_deferred("setup")` or wire through signals — never assume sibling `_ready` order.

## Signals — declare, connect, emit, await

```gdscript
signal damaged(amount: int)
signal died

func _ready() -> void:
    health.damaged.connect(_on_damaged)        # NEVER connect("damaged", ...) — loses types
    button.pressed.connect(_on_button.bind(id)) # .bind() appends args

func take_damage(amount: int) -> void:
    hp -= amount
    damaged.emit(amount)
    if hp <= 0: died.emit()

func play_intro() -> void:
    await animation_player.animation_finished
    load_main_menu()
```

| Cross-node need                                   | Pick                                       |
| ------------------------------------------------- | ------------------------------------------ |
| Child has news, parent might care                 | Child emits, parent connects in `_ready`   |
| Siblings need to communicate                      | Route through parent OR autoload event bus |
| Wait for one-shot (anim, timer, signal)           | `await some_signal`                        |
| Truly global event                                | Autoload `EventBus` with typed signals     |
| Direct method call up the tree (`get_parent().x`) | **Never** — emit instead                   |

Connections to freed nodes auto-clean. Disconnect manually only when a short-lived node is connected to a long-lived autoload (autoload outlives you → leak).

## Node access + common APIs

`$Player` = `get_node("Player")`. `%Anim` = unique-name lookup (decoupled from tree — mark in editor, refactor-friendly). `get_node_or_null("Maybe")` for nullable. `@onready var hp_bar: ProgressBar = $UI/HealthBar` resolves once, typed.

| Need                         | Call                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Load at parse / runtime      | `const X := preload("res://x.tscn")` / `load("res://x.tscn") as PackedScene`                                  |
| Spawn / change scene / pause | `X.instantiate() as MyType` / `get_tree().change_scene_to_file(...)` / `get_tree().paused = true`             |
| One-shot timer               | `await get_tree().create_timer(1.0).timeout`                                                                  |
| Input (rebindable)           | `Input.is_action_just_pressed("jump")`, `Input.get_vector(...)`                                               |
| File IO / tween / random     | `FileAccess.open("user://save.dat", ...)` / `create_tween().tween_property(...)` / `randi()`, `randf_range()` |

`res://` = read-only project assets. `user://` = writable per-user (saves, settings).

## Autoloads + Resources

Register an autoload in Project Settings → Autoload → accessible by name (`EventBus.player_died.emit()`). Use only for genuinely global services: event bus, save system, audio manager, scene loader. Not for "things that need to be reachable" — that's a god object.

`Resource` subclasses (`class_name WeaponStats extends Resource` with `@export` fields) save to `.tres`, drag into `@export var stats: WeaponStats`. Designers tune values without code. **Resources are shared by reference** — `duplicate()` if each instance needs its own copy.

## Performance — the cheap wins

Profile first (`Debugger → Profiler`, sort by **Self time**). Most frame time is rendering and physics, not GDScript. If GDScript isn't in the profiler top 10, optimizing it won't move the needle. Deep workups: see `references/gdscript-performance.md`.

| Lever                                                           | Win                                          |
| --------------------------------------------------------------- | -------------------------------------------- |
| `@onready` cached node refs                                     | Skip per-frame tree walk                     |
| `distance_squared_to` vs `distance_to`                          | Skip sqrt; compare against `radius * radius` |
| `&"name"` literals (StringName) for group/signal lookup         | Faster interned compare                      |
| Typed locals (`for n: int in numbers`)                          | Skip runtime type check                      |
| `set_process(false)` on idle nodes; or omit `_process` entirely | Empty `_process` still costs                 |
| `VisibleOnScreenNotifier2D/3D`                                  | Disable processing off-screen                |
| `PROCESS_MODE_DISABLED`                                         | Halt subtree (pause menu, inactive waves)    |
| Reuse a class-field array with `.clear()` in hot loops          | Zero per-frame allocation                    |
| `MultiMeshInstance` for repeated identical visuals              | Many objects → one draw call                 |
| Per-pixel / per-vertex work in a shader, not a script           | GPU is essentially free for this             |

Pool only what the profiler confirms as a hot spawn (bullets, particles, popups). Always reset state on reuse — pooled objects keep old field values. Premature pooling is its own debt.

## Anti-patterns

- `get_node("../../Foo")` chains — couple to tree structure. Use `%UniqueName` or signals
- Untyped public APIs (`func process(data):`) — type parameters AND return
- `var things = []` for class fields — type: `var things: Array[Thing] = []`
- `Variant` because "I'll figure out the type later" — later means never
- `as` cast without null-check after — `as` returns null, you'll crash on next deref
- `_process` for movement — frame-rate dependent. Use `_physics_process`
- `connect("damaged", ...)` (string-based) — loses type safety. Use `damaged.connect(...)`
- Imperative signal names (`kill_player`) — should be a fact (`player_died`). Untyped params — annotate
- Child reaches up: `get_parent().score += 10` — emit a signal, parent listens
- Autoload as dumping ground; logic in `_init` touching other nodes (they don't exist yet)
- Hard-coded keycodes in `_input` — use Input Map actions for rebindable controls
- `Resource` accidentally shared across instances — `duplicate()` for per-instance state
- `get_node()` inside `_process` — cache with `@onready`
- Allocating arrays/dicts every frame — reuse a class field with `.clear()`
- Polling values in `_process` — emit a signal where the value changes, subscribe
- Optimizing without profiling

## Red flags

| Thought                                       | Reality                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| "I'll just walk up the tree this once"        | Tomorrow that scene moves; everything breaks. Signal or unique name.                     |
| "Typing is just decoration"                   | It runs faster AND the IDE actually works. Type everything.                              |
| "Autoload it, easier"                         | Three releases later you have a global god object. Justify each autoload.                |
| "I'll poll in `_process` until it changes"    | Add a signal where the value changes. Subscribers fire on change only.                   |
| "`as` is safe, it can't fail"                 | It returns `null` on failure. Always null-check the result.                              |
| "I'll optimize this later"                    | The profiler will tell you it's already fine — or that the real bottleneck is elsewhere. |
| "Pool every bullet, every popup, every enemy" | Pool what shows up in the profiler. Premature pooling is its own debt.                   |

## Hand-off

For Godot scene composition, signals/exports/2D/3D/UI, multiplayer, GDExtension: `Skill(godot)`. For engine-agnostic game architecture (ECS, state machines, fixed timestep, asset pipelines): `Skill(game-dev-essentials)`. For deep perf workups (pooling patterns, shader migration, MultiMesh, allocation profiling): `references/gdscript-performance.md`.
