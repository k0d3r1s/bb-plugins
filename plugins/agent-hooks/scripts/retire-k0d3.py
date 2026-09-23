#!/usr/bin/env python3
"""Phase 4: retire the k0d3 plugin from all three providers.

Gated on `bb agent-hooks status --probe` being clean first -- removing k0d3 while
the replacement hooks are not actually firing would leave the machine unguarded.

Backs up every file it touches. Run with --dry-run to see the plan.

Deliberately does NOT delete /Users/k0d3r1s/workspace/projects/k0d3: that repo is
upstream for the devkit ports and the rollback route if a ported hook turns out
to be wrong after the caches are gone.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
STAMP = datetime.now().strftime("%Y%m%dT%H%M%S")

CLAUDE_SETTINGS = [
    HOME / ".claude" / "settings.json",
    HOME / ".claude-work" / "settings.json",
]
INSTALLED_PLUGINS = [
    HOME / ".claude" / "plugins" / "installed_plugins.json",
    HOME / ".claude-work" / "plugins" / "installed_plugins.json",
]
CODEX_CONFIG = HOME / ".codex" / "config.toml"
CACHES = [
    HOME / ".claude" / "plugins" / "cache" / "valksor-k0d3",
    HOME / ".claude-work" / "plugins" / "cache" / "valksor-k0d3",
    HOME / ".codex" / "plugins" / "cache" / "valksor-k0d3",
]

PLUGIN_KEY = "k0d3@valksor-k0d3"
MARKET_KEY = "valksor-k0d3"


def backup(path: Path, dry: bool) -> Path | None:
    if not path.exists():
        return None
    dest = path.with_name(f"{path.name}.pre-k0d3-retire-{STAMP}")
    if not dry:
        if path.is_dir():
            shutil.copytree(path, dest)
        else:
            shutil.copy2(path, dest)
    return dest


def edit_json(path: Path, mutate, dry: bool) -> list[str]:
    if not path.exists():
        return [f"skip (absent): {path}"]
    data = json.loads(path.read_text())
    notes: list[str] = []
    changed = mutate(data, notes)
    if not changed:
        return [f"no change: {path}"]
    backup(path, dry)
    if not dry:
        tmp = path.with_name(f".{path.name}.retire.tmp")
        tmp.write_text(json.dumps(data, indent=2) + "\n")
        tmp.replace(path)
    return notes


def drop_from_settings(data: dict, notes: list[str]) -> bool:
    changed = False
    plugins = data.get("enabledPlugins")
    if isinstance(plugins, dict) and PLUGIN_KEY in plugins:
        del plugins[PLUGIN_KEY]
        notes.append(f"  removed enabledPlugins['{PLUGIN_KEY}']")
        changed = True
    markets = data.get("extraKnownMarketplaces")
    if isinstance(markets, dict) and MARKET_KEY in markets:
        del markets[MARKET_KEY]
        notes.append(f"  removed extraKnownMarketplaces['{MARKET_KEY}']")
        changed = True
    return changed


def drop_from_installed(data: dict, notes: list[str]) -> bool:
    plugins = data.get("plugins")
    if isinstance(plugins, dict) and PLUGIN_KEY in plugins:
        del plugins[PLUGIN_KEY]
        notes.append(f"  removed plugins['{PLUGIN_KEY}']")
        return True
    return False


def clean_codex(dry: bool) -> list[str]:
    """Remove the marketplace stanza, the plugin stanza, and every hooks.state
    entry, by walking TOML section headers rather than regex-replacing blindly."""
    if not CODEX_CONFIG.exists():
        return [f"skip (absent): {CODEX_CONFIG}"]

    lines = CODEX_CONFIG.read_text().splitlines(keepends=True)
    header = re.compile(r"^\[")
    targets = (
        f'[marketplaces.{MARKET_KEY}]',
        f'[plugins."{PLUGIN_KEY}"]',
    )
    hooks_state = f'[hooks.state."{PLUGIN_KEY}:'

    out: list[str] = []
    removed: list[str] = []
    skipping = False
    for line in lines:
        if header.match(line):
            stripped = line.strip()
            if stripped in targets or stripped.startswith(hooks_state):
                skipping = True
                removed.append(stripped)
                continue
            skipping = False
        if not skipping:
            out.append(line)

    if not removed:
        return [f"no change: {CODEX_CONFIG}"]

    backup(CODEX_CONFIG, dry)
    if not dry:
        tmp = CODEX_CONFIG.with_name(f".{CODEX_CONFIG.name}.retire.tmp")
        tmp.write_text("".join(out))
        tmp.replace(CODEX_CONFIG)

    notes = [f"  removed {len(removed)} stanza(s) from {CODEX_CONFIG.name}:"]
    for r in removed:
        notes.append(f"    {r}")
    return notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry = args.dry_run

    print(f"{'DRY RUN -- nothing will be written' if dry else 'APPLYING'}\n")

    print("provider settings:")
    for p in CLAUDE_SETTINGS:
        for note in edit_json(p, drop_from_settings, dry):
            print(note if note.startswith(" ") else f"  {note}")

    print("\ninstalled_plugins.json:")
    for p in INSTALLED_PLUGINS:
        for note in edit_json(p, drop_from_installed, dry):
            print(note if note.startswith(" ") else f"  {note}")

    print("\ncodex config.toml:")
    for note in clean_codex(dry):
        print(note if note.startswith(" ") else f"  {note}")

    print("\nplugin caches:")
    for c in CACHES:
        if not c.exists():
            print(f"  skip (absent): {c}")
            continue
        size = sum(f.stat().st_size for f in c.rglob("*") if f.is_file())
        print(f"  remove {c}  ({size / 1_048_576:.1f} MB)")
        if not dry:
            shutil.rmtree(c)

    print("\nKEPT on purpose: ~/workspace/projects/k0d3 (upstream for devkit ports, rollback route)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
