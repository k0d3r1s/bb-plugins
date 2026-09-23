import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { CODEGRAPH_TOOL_NAMES, executeCodeGraphTool } from "../src/codegraph.mjs";

const fakeServerSource = `#!${process.execPath}
const readline = require("node:readline");
const mode = process.env.FAKE_CODEGRAPH_MODE;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answers = [];
let callId = null;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode === "invalid-json") {
      process.stdout.write("this is not json\\n");
      return;
    }
    if (mode === "huge") {
      process.stdout.write("x".repeat(2_100_000));
      return;
    }
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05" } });
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    answers.push(message);
    if (answers.length === 3) {
      write({ jsonrpc: "2.0", id: 999, result: { ignored: true } });
      write({ jsonrpc: "2.0", id: callId, result: { content: [{ type: "text", text: JSON.stringify(answers) }] } });
    }
    return;
  }
  if (message.method !== "tools/call") {
    return;
  }
  callId = message.id;
  if (mode === "error-result") {
    write({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "index is corrupt" }] } });
  } else if (mode === "empty-error") {
    write({ jsonrpc: "2.0", id: message.id, result: { isError: true } });
  } else if (mode === "empty-result") {
    write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "image", data: "" }] } });
  } else if (mode === "rpc-error") {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "bad params" } });
  } else if (mode === "rpc-error-blank") {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32602 } });
  } else if (mode === "context-unknown") {
    if (message.params.name === "codegraph_context") {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown tool: codegraph_context" } });
    } else {
      write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params) }] } });
    }
  } else if (mode === "server-requests") {
    write({ jsonrpc: "2.0", id: "roots", method: "roots/list" });
    write({ jsonrpc: "2.0", id: "ping", method: "ping" });
    write({ jsonrpc: "2.0", id: "sample", method: "sampling/createMessage", params: {} });
  } else if (mode === "exit") {
    process.stderr.write("indexer crashed\\n");
    process.exit(3);
  } else if (mode === "hang") {
    process.stderr.write("still indexing\\n");
  }
});
`;

async function createFixture(t) {
  const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-codegraph-")));
  t.after(async () => {
    await chmod(path.join(fixtureRoot, "codegraph"), 0o755).catch(() => {});
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const codegraphRoot = path.join(fixtureRoot, "codegraph");
  const command = path.join(codegraphRoot, "bin", "codegraph.cjs");
  const workspaceRoot = path.join(fixtureRoot, "workspace");
  await mkdir(path.dirname(command), { recursive: true, mode: 0o755 });
  await chmod(codegraphRoot, 0o755);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(command, fakeServerSource, { mode: 0o755 });
  const policy = { codegraphCommand: command, codegraphRoot };
  const workspace = { hostRoot: workspaceRoot };
  const call = (mode, toolName = "codegraph_search", input = { query: "Router" }, options = {}) =>
    executeCodeGraphTool(policy, workspace, toolName, input, {
      timeoutMs: 5_000,
      spawn(file, args, spawnOptions) {
        return spawn(file, args, {
          ...spawnOptions,
          env: { ...spawnOptions.env, FAKE_CODEGRAPH_MODE: mode },
        });
      },
      ...options,
    });
  return { call, codegraphRoot, command, fixtureRoot, policy, workspace, workspaceRoot };
}

test("CodeGraph refuses unsupported tools, aborted requests, and unsafe arguments before spawning", async (t) => {
  const fixture = await createFixture(t);
  let spawned = 0;
  const neverSpawn = () => {
    spawned += 1;
    throw new Error("must not spawn");
  };
  const reject = (toolName, input, options = {}) =>
    executeCodeGraphTool(fixture.policy, fixture.workspace, toolName, input, {
      spawn: neverSpawn,
      ...options,
    });
  assert.ok(CODEGRAPH_TOOL_NAMES.includes("codegraph_search"));
  await assert.rejects(reject("codegraph_delete", {}), /Shared runtime CodeGraph denied: unsupported tool/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reject("codegraph_search", { query: "x" }, { signal: controller.signal }),
    /^Error: CodeGraph request aborted$/,
  );
  for (const [input, expected] of [
    [{ file: "/etc/passwd" }, /file must be a relative workspace path/],
    [{ path: "src\0x" }, /path must be a relative workspace path/],
    [{ path: 7 }, /path must be a relative workspace path/],
    [{ path: "src/../../x" }, /path escapes the authorized workspace/],
    [{ file: ".." }, /file escapes the authorized workspace/],
  ]) {
    await assert.rejects(reject("codegraph_node", input), expected, JSON.stringify(input));
  }
  assert.equal(spawned, 0);
});

test("CodeGraph requires an operator-pinned, owner-controlled installation", async (t) => {
  const fixture = await createFixture(t);
  const attempt = (policy, workspace = fixture.workspace) =>
    executeCodeGraphTool(policy, workspace, "codegraph_search", { query: "x" }, {
      spawn: () => {
        throw new Error("must not spawn");
      },
    });
  for (const policy of [
    {},
    { codegraphCommand: fixture.command },
    { codegraphCommand: "bin/codegraph", codegraphRoot: fixture.codegraphRoot },
    { codegraphCommand: fixture.command, codegraphRoot: "codegraph" },
  ]) {
    await assert.rejects(
      attempt(policy),
      /CodeGraph is not pinned in the operator policy; rerun bb-shared-runtime install/,
    );
  }
  const outside = path.join(fixture.fixtureRoot, "outside.cjs");
  await writeFile(outside, "", { mode: 0o755 });
  await assert.rejects(
    attempt({ codegraphCommand: outside, codegraphRoot: fixture.codegraphRoot }),
    /operator-pinned CodeGraph paths changed/,
  );
  const alias = path.join(fixture.fixtureRoot, "codegraph-alias");
  await symlink(fixture.codegraphRoot, alias);
  await assert.rejects(
    attempt({ codegraphCommand: path.join(alias, "bin", "codegraph.cjs"), codegraphRoot: alias }),
    /operator-pinned CodeGraph paths changed/,
  );

  await chmod(fixture.codegraphRoot, 0o777);
  await assert.rejects(
    attempt(fixture.policy),
    /operator-pinned CodeGraph root has unsafe ownership or permissions/,
  );
  await chmod(fixture.codegraphRoot, 0o755);
  await chmod(fixture.command, 0o644);
  await assert.rejects(attempt(fixture.policy), /operator-pinned CodeGraph command is not executable/);
  await chmod(fixture.command, 0o755);

  const workspaceAlias = path.join(fixture.fixtureRoot, "workspace-alias");
  await symlink(fixture.workspaceRoot, workspaceAlias);
  await assert.rejects(
    attempt(fixture.policy, { hostRoot: workspaceAlias }),
    /workspace path changed after authorization/,
  );
});

test("CodeGraph answers server-initiated requests and ignores unknown replies", async (t) => {
  const fixture = await createFixture(t);
  const answers = JSON.parse(await fixture.call("server-requests"));
  assert.deepEqual(answers, [
    {
      jsonrpc: "2.0",
      id: "roots",
      result: {
        roots: [{ uri: pathToFileURL(fixture.workspaceRoot).href, name: "Shared runtime workspace" }],
      },
    },
    { jsonrpc: "2.0", id: "ping", result: {} },
    {
      jsonrpc: "2.0",
      id: "sample",
      error: { code: -32601, message: "Unsupported server request" },
    },
  ]);
});

test("CodeGraph tool errors, RPC errors, and empty results are rendered faithfully", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(fixture.call("error-result"), /^Error: index is corrupt$/);
  await assert.rejects(fixture.call("empty-error"), /^Error: CodeGraph returned an error$/);
  assert.equal(await fixture.call("empty-result"), JSON.stringify({ content: [{ type: "image", data: "" }] }));
  await assert.rejects(fixture.call("rpc-error"), /^Error: bad params$/);
  await assert.rejects(fixture.call("rpc-error-blank"), /^Error: CodeGraph RPC error$/);
  await assert.rejects(
    fixture.call("rpc-error", "codegraph_context", { task: "x" }),
    /^Error: bad params$/,
    "context only falls back for a missing tool",
  );
  const fallback = JSON.parse(
    await fixture.call("context-unknown", "codegraph_context", { task: "trace startup", maxNodes: 1000 }),
  );
  assert.equal(fallback.name, "codegraph_explore");
  assert.deepEqual(fallback.arguments, {
    query: "trace startup",
    maxFiles: 20,
    projectPath: fixture.workspaceRoot,
  });
  const unbounded = JSON.parse(
    await fixture.call("context-unknown", "codegraph_context", { task: "trace startup" }),
  );
  assert.deepEqual(unbounded.arguments, { query: "trace startup", projectPath: fixture.workspaceRoot });
});

test("CodeGraph protocol failures, crashes, timeouts, and aborts fail closed", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(fixture.call("invalid-json"), /^Error: CodeGraph returned invalid JSON-RPC$/);
  await assert.rejects(fixture.call("huge"), /^Error: CodeGraph response exceeded its output bound$/);
  await assert.rejects(
    fixture.call("exit"),
    /^Error: CodeGraph exited before replying \(3\);( indexer crashed)?$/,
  );
  await assert.rejects(
    fixture.call("hang", "codegraph_search", { query: "x" }, { timeoutMs: 1_000 }),
    /^Error: CodeGraph timed out;( still indexing)?$/,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    fixture.call("hang", "codegraph_search", { query: "x" }, { signal: controller.signal }),
    /^Error: CodeGraph request aborted$/,
  );
  await assert.rejects(
    executeCodeGraphTool(fixture.policy, fixture.workspace, "codegraph_search", { query: "x" }, {
      spawn: () => spawn(path.join(fixture.fixtureRoot, "missing-binary"), [], { stdio: ["pipe", "pipe", "pipe"] }),
    }),
    { code: "ENOENT" },
  );
});
