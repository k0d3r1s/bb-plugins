# GDScript Performance — Deep Workups

Linked from `Skill(gdscript)`. The cheap-wins table lives in the main skill; this reference covers profiling discipline, pooling patterns in detail, and the allocation/StringName/shader explanations.

## Profile first — what the profiler actually tells you

`Debugger → Profiler` while the game runs. Sort by **Self time** (time inside the function, excludes callees). The hot spots are almost never where you guessed. `Debugger → Monitors` tracks draw calls, object count, video memory — for spotting non-script regressions.

If GDScript isn't in the profiler top 10, optimizing it won't move the needle. Spend the budget on rendering (draw calls, overdraw, shaders) or physics (collision shapes, broadphase, fixed-step rate) instead.

## Tick budgets — pick the right callback

| Callback                  | When                              | Use for                                   | Don't                                      |
| ------------------------- | --------------------------------- | ----------------------------------------- | ------------------------------------------ |
| `_process(delta)`         | Every visual frame, variable rate | Visuals, UI, camera                       | Movement that interacts with physics       |
| `_physics_process(delta)` | Fixed step (60 Hz default)        | Movement, collision response, AI steering | Pure visuals (runs more often than needed) |
| Signal handler            | Event-driven                      | "Reacts when X happens"                   | Polling masquerading as events             |

**Empty `_process` still costs.** If a node doesn't need per-frame updates, don't define `_process`, or call `set_process(false)`. Same for `set_physics_process(false)`, `set_process_input(false)`.

```gdscript
func _ready() -> void:
    set_process(false)               # don't tick until something needs it
    enemy_seen.connect(_on_enemy_seen)

func _on_enemy_seen() -> void:
    set_process(true)                # now we need the heartbeat
```

## Cache node lookups

`get_node()` walks the tree each call. `@onready` resolves once:

```gdscript
# Walks the tree 60x/sec
func _process(_delta: float) -> void:
    $UI/HealthBar.value = hp

# Resolved once at _ready, typed for autocomplete
@onready var health_bar: ProgressBar = $UI/HealthBar
func _process(_delta: float) -> void:
    health_bar.value = hp
```

Always type the `@onready` var. Same for `get_tree().get_nodes_in_group("enemies")` — cache if the group is stable.

## Allocations — zero in hot loops

Every `[]`, `{}`, `Array.new()`, `Vector2(x, y)` allocates. In a per-frame loop that compounds:

```gdscript
# Allocates an Array every frame
func _physics_process(_delta: float) -> void:
    var nearby := []
    for e in enemies:
        if global_position.distance_to(e.global_position) < 100.0:
            nearby.append(e)

# Reuse a class field
var _nearby: Array[Enemy] = []
func _physics_process(_delta: float) -> void:
    _nearby.clear()
    for e in enemies:
        if global_position.distance_squared_to(e.global_position) < 100.0 * 100.0:
            _nearby.append(e)
```

**`distance_squared_to` beats `distance_to`** — no sqrt. Compare against `radius * radius`.

## Object pooling

Spawning + freeing thrashes memory and runs `_ready` repeatedly. Pool things that fire often (bullets, particles, popups, damage numbers):

```gdscript
const POOL_SIZE := 64
var _pool: Array[Bullet] = []

func _ready() -> void:
    for i in POOL_SIZE:
        var b := bullet_scene.instantiate() as Bullet
        b.process_mode = Node.PROCESS_MODE_DISABLED
        b.visible = false
        add_child(b)
        _pool.append(b)

func get_bullet() -> Bullet:
    for b in _pool:
        if not b.active:
            b.activate()
            return b
    return null                       # pool exhausted — resize or drop
```

**Reset state on reuse.** Pooled objects keep old field values — set everything explicitly on `activate()`. Pools add complexity; only pool what shows up in the profiler.

## Typed code, StringName, shaders

Typed GDScript skips runtime type checks — `for n: int in numbers` beats `for n in numbers`. `Array[int]` iterates faster than untyped `Array`.

For repeated string-keyed lookups (groups, animations, generic node queries), use `StringName` literals: `add_to_group(&"enemies")`, `get_animation(&"walk")`. Interned, fast compare. For signals, prefer the typed `damaged.emit(10)` form — `emit_signal()` is the legacy untyped fallback.

**Anything per-pixel or per-vertex belongs in a shader, not a script.** A `_process` moving 1000 vertices chokes; the same vertex shader runs essentially free on GPU.

## Anti-patterns checklist

- `get_node()` inside `_process` — cache with `@onready`
- Allocating arrays/dicts every frame — reuse a class field with `.clear()`
- `_process` defined on every node, idle ones included — `set_process(false)` or omit
- Physics-style movement in `_process` (frame-rate dependent) — use `_physics_process`
- Instantiating / `load()`ing in `_process` — pool / preload
- Polling values in `_process` — emit a signal where the value changes, subscribe
- Optimizing without profiling; pooling everything (only pool profiler-confirmed hot spawns)
- Per-frame `print()`; `distance_to` for radius checks (use `distance_squared_to`)
- String-keyed hot-path lookups (`"enemies"`) — use `&"enemies"` (StringName)

## Red flags

| Thought                                       | Reality                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| "I'll optimize this later"                    | The profiler will tell you it's already fine — or that the real bottleneck is elsewhere. |
| "Pool every bullet, every popup, every enemy" | Pool what shows up in the profiler. Premature pooling is its own debt.                   |
| "It's just one `get_node` call"               | Times 60/sec, times N nodes. `@onready` is free.                                         |
| "`_process(_delta)` with `pass` is harmless"  | Engine ticks it. Multiply by hundreds of idle nodes.                                     |
| "Shader is overkill"                          | If it's per-vertex or per-pixel, shader is the right tool. Script is wrong.              |
