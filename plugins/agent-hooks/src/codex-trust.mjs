// Codex hook trust: config.toml `[hooks.state."<source>:<event>:<group>:<idx>"]`.
//
// Codex runs a hooks.json hook only when config.toml holds a trusted_hash for it
// that matches the hook's current hash. The key is POSITIONAL, so any rewrite of
// hooks.json that adds or removes a group silently leaves hooks "untrusted" or
// "modified" -- listed, counted by `status`, and never run. That is how the
// k0d3 -> agent-hooks move left every gate dark in Codex. The hash is content-
// based, so a hook that merely moved keeps its hash; that is what makes re-keying
// safe.
//
// Codex's own `app-server` (`hooks/list`) is the only authority for keys and
// hashes; the hash algorithm is deliberately not reproduced here.
//
// After a rewrite, trust is re-issued for exactly:
//   - our entries, matched by EXACT command string against what planCodex writes
//     (install has already checksum-verified the scripts those commands run)
//   - any other hook whose current hash was already trusted under some key
// Everything else stays untrusted, as Codex itself would leave it.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { backupConfig } from "./wire.mjs";

export const CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

/** Binaries to try in order; the first that answers hooks/list wins. */
export function codexCandidates(env = process.env) {
  return [
    env.CODEX_BIN,
    "codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ].filter(Boolean);
}

/** Ask `<bin> app-server` for every hook it sees from `cwd`, with key/hash/status. */
export function listCodexHooks(bin, { cwd = os.homedir(), timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error(`${bin} app-server: no hooks/list reply in ${timeoutMs}ms`)), timeoutMs);
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    child.on("error", (err) => done(err));
    child.on("exit", (code) => done(new Error(`${bin} app-server exited (${code}) before replying`)));
    child.stdin.on("error", () => {}); // EPIPE when the binary is not an app-server; "exit" reports it
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
      } else if (msg.id === 2) {
        if (msg.error) done(new Error(`hooks/list: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else done(null, (msg.result?.data ?? []).flatMap((d) => d.hooks ?? []));
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "bb-agent-hooks", version: "0" } } });
  });
}

const HEADER = /^\s*\[/;
const STATE_HEADER = /^\s*\[\s*hooks\.state\."((?:[^"\\]|\\.)*)"\s*\]\s*(#.*)?$/;
const TRUSTED_HASH = /^\s*trusted_hash\s*=\s*"([^"]*)"\s*(#.*)?$/;
const tomlKey = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Rewrite the hooks.state sections that belong to `sourcePath`, leaving every
 * other byte of config.toml alone. Pure: text + hooks in, text out.
 *
 * Refuses (returns `error`) when one of those sections carries anything besides
 * trusted_hash: that state is positional too, and re-keying it by guesswork could
 * attach it to the wrong hook.
 */
export function retrust(text, hooks, { sourcePath, ourCommands }) {
  const lines = text.split(/(?<=\n)/);
  const kept = [];
  const previouslyTrusted = new Set();
  let insertAt = -1;
  let inOurs = false;

  for (const line of lines) {
    if (HEADER.test(line)) {
      const m = STATE_HEADER.exec(line);
      inOurs = Boolean(m) && m[1].startsWith(`${sourcePath}:`);
      if (inOurs) {
        if (insertAt < 0) insertAt = kept.length;
        continue;
      }
    }
    if (!inOurs) {
      kept.push(line);
      continue;
    }
    const hash = TRUSTED_HASH.exec(line);
    if (hash) previouslyTrusted.add(hash[1]);
    else if (line.trim() !== "" && !line.trim().startsWith("#")) {
      return { error: `unexpected hook state in ${sourcePath} section: ${line.trim()}` };
    }
  }

  const mine = hooks.filter((h) => h.sourcePath === sourcePath || String(h.key).startsWith(`${sourcePath}:`));
  const trust = mine.filter(
    (h) => h.currentHash && (ourCommands.has(h.command) || previouslyTrusted.has(h.currentHash)),
  );
  const block = trust.map((h) => `[hooks.state."${tomlKey(h.key)}"]\ntrusted_hash = "${h.currentHash}"\n\n`).join("");

  // Replace in place where our sections were; otherwise append after one blank line.
  let head = kept.slice(0, insertAt < 0 ? kept.length : insertAt).join("");
  const rest = insertAt < 0 ? "" : kept.slice(insertAt).join("");
  if (insertAt < 0 && block && head !== "") head = head.replace(/\n*$/, "\n\n");
  const out = rest === "" && block ? (head + block).replace(/\n+$/, "\n") : head + block + rest;

  return {
    text: out,
    trusted: trust.map((h) => h.key),
    untrusted: mine.filter((h) => !trust.includes(h)).map((h) => h.key),
  };
}

function writeTextAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.agent-hooks.tmp`);
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

async function firstAnswer(bins, list) {
  const errors = [];
  for (const bin of bins) {
    try {
      return { bin, hooks: await list(bin) };
    } catch (err) {
      errors.push(`${bin}: ${err.message}`);
    }
  }
  return { errors };
}

/**
 * Report (and unless `readOnly`, repair) Codex trust for our hooks.json.
 * Never throws for a missing or unresponsive Codex: that is `status: "skipped"`.
 */
export async function syncCodexTrust({
  sourcePath,
  ourCommands,
  configPath = CODEX_CONFIG,
  bins = codexCandidates(),
  list = listCodexHooks,
  readOnly = false,
}) {
  const first = await firstAnswer(bins, list);
  if (!first.hooks) return { status: "skipped", reason: `no codex app-server answered (${first.errors.join("; ")})` };

  const ours = (hooks) =>
    hooks.filter((h) => (h.sourcePath === sourcePath || String(h.key).startsWith(`${sourcePath}:`)) && ourCommands.has(h.command));
  const summary = (hooks) => {
    const o = ours(hooks);
    return { ours: o.length, oursTrusted: o.filter((h) => h.trustStatus === "trusted").length };
  };
  if (readOnly) return { status: "ok", bin: first.bin, ...summary(first.hooks) };

  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const res = retrust(before, first.hooks, { sourcePath, ourCommands });
  if (res.error) return { status: "refused", reason: res.error };
  if (res.text === before) return { status: "ok", bin: first.bin, changed: false, ...summary(first.hooks) };

  const backup = backupConfig(configPath);
  writeTextAtomic(configPath, res.text);
  // Re-ask Codex rather than trusting our own write: the point is that it RUNS them.
  const after = await firstAnswer([first.bin], list);
  const verified = after.hooks ? summary(after.hooks) : { ours: ours(first.hooks).length, oursTrusted: 0 };
  return { status: "ok", bin: first.bin, changed: true, backup, untrusted: res.untrusted, ...verified };
}
