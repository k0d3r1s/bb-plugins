# Godot 4 High-Level Multiplayer — Full Workflow

Linked from `Skill(godot)`. The summary lives in the main skill. Use this reference when actually building networked games — peer setup, authority, RPC annotation slots, `MultiplayerSpawner`/`Synchronizer`, transport tradeoffs, lag compensation, common pitfalls.

**Iron Law: server is authoritative. Clients predict, server confirms, reconcile on mismatch.**

## Peer model

```
ENetMultiplayerPeer (server)         peer_id = 1
├── ENetMultiplayerPeer (client A)   peer_id = 2 (random ≥ 2)
├── ENetMultiplayerPeer (client B)   peer_id = 3
└── ENetMultiplayerPeer (client C)   peer_id = 4
```

- **Server** is `peer_id = 1`. Always exists in client-server topology.
- **Clients** get random IDs ≥ 2 on connect.
- `multiplayer.get_unique_id()` → this peer's ID.
- `multiplayer.is_server()` → `get_unique_id() == 1`.

```gdscript
# host
var peer := ENetMultiplayerPeer.new()
peer.create_server(7777, 8)         # port, max clients
multiplayer.multiplayer_peer = peer

# client
var peer := ENetMultiplayerPeer.new()
peer.create_client("192.168.1.10", 7777)
multiplayer.multiplayer_peer = peer
```

Listen to `multiplayer.peer_connected(id)`, `peer_disconnected(id)`, `connected_to_server`, `connection_failed`, `server_disconnected`. **Always handle `connection_failed`** — UI hangs otherwise.

## Authority — the gate on every write

Every node has a _multiplayer authority_ — the peer that decides its state. Default is the server. Set per-node:

```gdscript
func _ready() -> void:
    set_multiplayer_authority(peer_id_of_owner)
```

Inside RPCs and state code, gate writes:

```gdscript
func _physics_process(delta: float) -> void:
    if not is_multiplayer_authority():
        return                              # only the owning peer simulates
    velocity = read_input() * SPEED
    move_and_slide()
```

**The authority computes truth; everyone else sees a synchronized reflection.**

## RPCs — sparingly

```gdscript
@rpc("any_peer", "call_local", "reliable")
func shoot(direction: Vector2) -> void:
    # `any_peer` means ANY client can invoke this. ALWAYS validate the sender
    # owns this node before acting — otherwise a malicious peer can spawn bullets
    # from another player's position.
    if multiplayer.get_remote_sender_id() != get_multiplayer_authority():
        return
    # Range-check numeric inputs server-side — Vector2(1e38, 1e38) → NaN in physics.
    if direction.length() > 1.0 + 0.01:  # accept normalized + tiny float drift
        return
    spawn_bullet(direction)
```

Four annotation slots:

| Slot         | Options                                              | Default         |
| ------------ | ---------------------------------------------------- | --------------- |
| Who can call | `"authority"`, `"any_peer"`                          | `"authority"`   |
| Local call   | `"call_local"`, `"call_remote"`                      | `"call_remote"` |
| Mode         | `"reliable"`, `"unreliable"`, `"unreliable_ordered"` | `"reliable"`    |
| Channel      | int                                                  | `0`             |

Call patterns:

```gdscript
shoot.rpc(dir)                              # call on all remote peers
shoot.rpc_id(target_peer, dir)              # call on a specific peer
shoot.rpc_id(1, dir)                        # call on server only
```

**Use sparingly.** Every RPC is a packet. For continuous state (position, health), use `MultiplayerSynchronizer`.

## MultiplayerSpawner

Add a `MultiplayerSpawner` node. Set `spawn_path` (parent for spawned children) + `_spawnable_scenes` list. Server calls `add_child()` under that path and the spawner replicates to every client (and to new mid-game joiners).

```gdscript
# server only
func spawn_player(peer_id: int) -> void:
    var p := PLAYER_SCENE.instantiate()
    p.name = str(peer_id)
    p.set_multiplayer_authority(peer_id)
    $Players.add_child(p, true)             # MultiplayerSpawner sees add_child
```

**Set authority before adding to tree** — otherwise the first physics tick runs with the wrong authority.

## MultiplayerSynchronizer

Child of the node whose state you replicate. Edit its `replication_config` to list properties + sync mode:

```
Player (CharacterBody2D)
├── MultiplayerSynchronizer
│   └── replication_config:
│       - "Player:position"      sync: always
│       - "Player:velocity"      sync: always
│       - "Player:hp"            sync: on_change
│       - "Player:state"         sync: on_change
└── ...
```

**Sync modes**: `always` (positions, velocities), `on_change` (HP, state, name), `never` (spawn-time values only). Authority writes the property; synchronizer pushes diffs at `replication_interval` (e.g., 100 ms = 10 Hz). Non-authority peers shouldn't write to those fields.

## Topology — pick by game type

| Topology                              | Pros                                          | Cons                                                    | Use when                           |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| **Client-server** (Godot default)     | One source of truth, simpler cheat prevention | Server is SPOF; needs hosting                           | Most games                         |
| **Listen server** (one player hosts)  | No infra cost                                 | Host has latency advantage; host disconnect = game over | Casual co-op                       |
| **Peer-to-peer** (all peers equal)    | No server needed                              | Hard to reach consensus, complex sync, NAT issues       | Fighting games, deterministic sims |
| **Dedicated server** (headless Godot) | Fairness, persistent                          | Hosting cost                                            | Competitive games                  |

**Dedicated server build (Godot 4)**: export with the "Linux Server" / "macOS Server" template; run the resulting binary with `--headless` only. The Godot-3 `--server` flag was removed — Godot 4 ships a separate server export template instead.

### Transport tradeoffs

| Transport          | Pros                                            | Cons                                                           | When                                |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| **ENet** (default) | UDP, low-latency, NAT punch-through via relay   | No browser support; needs hosting                              | Native client games                 |
| **WebSocket**      | Browser-compatible, TCP-reliable, easy proxying | Higher baseline latency (TCP head-of-line)                     | Browser-exported games, casual      |
| **WebRTC**         | P2P, browser, NAT-friendly                      | Complex signaling (needs STUN/TURN); harder reliability tuning | Browser P2P (fighting games, voice) |

## Lag compensation

Network lag (50-200 ms typical) means clients see a stale world. Three mitigations:

### 1. Client-side prediction

Client simulates its own input immediately; reconciles when the server's authoritative state arrives. Used for fast-paced shooters.

```gdscript
func _physics_process(delta: float) -> void:
    if is_multiplayer_authority():
        apply_local_input(delta)                # predict
    else:
        interpolate_to_server_state(delta)      # smooth remote movement
```

### 2. Entity interpolation

For remote players/enemies, render them ~100 ms in the past so packets always have arrived. Smoother visuals at the cost of input latency.

### 3. Lag-compensated hit detection

When player A shoots, server rewinds player B to where A _saw_ B when firing, then checks the hit. Common in FPS netcode.

**For turn-based / slow-paced (RTS, card games), don't bother** — just RPC the actions.

## The trust boundary

**Never trust the client.** Server validates everything: damage taken, item picked up, position deltas (snap-back on impossible moves), action cooldowns. Client-authoritative for visual-only state (cosmetic emotes); server-authoritative for anything that affects gameplay.

## Common pitfalls

| Pitfall                                      | Fix                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Both peers write to the same property        | Only the authority writes                                               |
| RPC every frame                              | Use `MultiplayerSynchronizer` for continuous state                      |
| `call_local = false` + immediate UI feedback | Shooter feels laggy; add local prediction or `call_local`               |
| Spawning outside the spawner's `spawn_path`  | Children added elsewhere aren't replicated                              |
| Authority set after `add_child`              | First physics tick wrong; set before                                    |
| Mixing peer IDs and player IDs               | peer_id can change across sessions; track players by your own player_id |

## Anti-patterns

- Trusting the client — never let a client decide its own damage taken
- Heavy `_process` on non-authority — non-authority should mostly render
- Same scene on server + client with `is_server()` branches everywhere — split server-only logic into separate nodes added only on the server
- No timeout on `connection_failed` — UI hangs forever
- Strings via RPC for everything — use int enums and packed types; bandwidth matters
- `MultiplayerSynchronizer` interval set to 1 (60 Hz) for slow-moving things — bandwidth waste
- Replicating physics simulation instead of input + reconciliation — diverges fast
