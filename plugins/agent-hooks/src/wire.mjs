// Merging hook entries into provider config files.
//
// Three differently-shaped targets, one shared set of safety rules:
//   ~/.claude/settings.json       hooks.* already holds the iterm2 cc-status entry
//                                 on ten events
//   ~/.claude-work/settings.json  has hooks.Stop with an EMPTY hooks array and no
//                                 PreToolUse key at all -- the merge must create
//                                 keys, never assume them
//   ~/.codex/hooks.json           carries gitkraken on nine events plus
//                                 auto-review-commit.sh, deny-bgisolation-none.sh
//                                 and zclean, all of which must survive
//
// Our entries are identified by their command-path prefix (~/.bb/agent-hooks/).
// Verified safe: all three configs store each hook as a single command string, and
// no existing neighbour uses that prefix.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const INSTALL_DIR = path.join(os.homedir(), ".bb", "agent-hooks");

/** Which hook runs on which event, per host dialect. */
export const WIRING = [
  { script: "guard-bash.sh", claude: [{ event: "PreToolUse", matcher: "Bash" }], codex: ["pre_tool_use"] },
  { script: "secret-scan.sh", claude: [{ event: "PreToolUse", matcher: "Write|Edit|MultiEdit" }], codex: ["pre_tool_use"] },
  { script: "review-plan-before-exit.sh", claude: [{ event: "PreToolUse", matcher: "ExitPlanMode" }], codex: ["pre_tool_use"] },
  { script: "verify-before-stop.sh", claude: [{ event: "Stop" }, { event: "SubagentStop" }], codex: ["stop", "subagent_stop"] },
  { script: "session-reset.sh", claude: [{ event: "SessionStart" }], codex: ["session_start"] },
];

export const PROVIDERS = {
  "claude-code": { kind: "claude", config: path.join(os.homedir(), ".claude", "settings.json") },
  "claude-work": { kind: "claude", config: path.join(os.homedir(), ".claude-work", "settings.json") },
  codex: { kind: "codex", config: path.join(os.homedir(), ".codex", "hooks.json") },
};

const isOurs = (cmd) => typeof cmd === "string" && cmd.includes("/.bb/agent-hooks/");

/** Read + parse, or throw with a message naming the file. Never "repair" it. */
export function readConfig(file) {
  if (!existsSync(file)) return { existed: false, data: {} };
  const raw = readFileSync(file, "utf8");
  if (raw.trim() === "") return { existed: true, data: {} };
  try {
    return { existed: true, data: JSON.parse(raw) };
  } catch (err) {
    // Refuse rather than merge into something already broken -- a "repaired"
    // write here could destroy a config we do not understand.
    throw new Error(
      `${file} is not valid JSON (${err.message}). Refusing to touch it. ` +
        `Fix or restore the file, then run install again.`,
    );
  }
}

/** Atomic: write a temp file in the same directory, then rename over the target.
 *  A crash mid-write would otherwise leave invalid JSON, which disables EVERY
 *  hook on that provider -- not just ours. */
export function writeConfigAtomic(file, data) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.agent-hooks.tmp`);
  const text = JSON.stringify(data, null, 2) + "\n";
  JSON.parse(text); // never emit something we cannot read back
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Timestamped backup beside the config, taken before the first write. */
export function backupConfig(file) {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.agent-hooks-backup-${stamp}`;
  copyFileSync(file, dest);
  return dest;
}

function claudeEntry(script, matcher) {
  const entry = { hooks: [{ type: "command", command: path.join(INSTALL_DIR, script) }] };
  if (matcher !== undefined) entry.matcher = matcher;
  return entry;
}

/** Remove only our entries, preserving every neighbour and every empty-array
 *  quirk we did not create. */
function stripOurs(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => {
        if (!g || !Array.isArray(g.hooks)) return g;
        const inner = g.hooks.filter((h) => !isOurs(h?.command));
        if (inner.length === 0 && g.hooks.length > 0) return null; // was entirely ours
        return { ...g, hooks: inner };
      })
      .filter((g) => g !== null);
    out[event] = kept;
  }
  return out;
}

export function planClaude(data) {
  const next = structuredClone(data ?? {});
  next.hooks = stripOurs(next.hooks);
  for (const { script, claude } of WIRING) {
    for (const { event, matcher } of claude) {
      if (!Array.isArray(next.hooks[event])) next.hooks[event] = []; // create, never assume
      next.hooks[event].push(claudeEntry(script, matcher));
    }
  }
  return next;
}

export function planCodex(data) {
  const next = structuredClone(data ?? {});
  next.hooks = stripOurs(next.hooks);
  const shim = path.join(INSTALL_DIR, "codex-shim.sh");
  for (const { script, codex } of WIRING) {
    for (const event of codex) {
      if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
      next.hooks[event].push({
        hooks: [{ type: "command", command: `'${shim}' '${path.join(INSTALL_DIR, script)}'` }],
      });
    }
  }
  return next;
}

export function planUninstall(data) {
  const next = structuredClone(data ?? {});
  next.hooks = stripOurs(next.hooks);
  return next;
}

export function plan(kind, data, { uninstall = false } = {}) {
  if (uninstall) return planUninstall(data);
  return kind === "codex" ? planCodex(data) : planClaude(data);
}

/** How many of our entries a config currently holds. */
export function countOurs(data) {
  let n = 0;
  for (const groups of Object.values(data?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of g?.hooks ?? []) if (isOurs(h?.command)) n += 1;
  }
  return n;
}

/** Total entries we would install, for the status bar. */
export function expectedCount(kind) {
  return WIRING.reduce((n, w) => n + (kind === "codex" ? w.codex.length : w.claude.length), 0);
}
