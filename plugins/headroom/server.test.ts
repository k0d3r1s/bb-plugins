import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHeadroomPlugin } from "./server.js";
import { parseProxyUrl, type SpawnLike } from "./src/proxy.js";

const SERVER_HOST = "host_server";
const CONTEXT = { threadId: "thr_1", projectId: "proj_1", hostId: SERVER_HOST };

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: string[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
  crash(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

interface Rig {
  up: boolean;
  probes: string[];
  spawns: Array<{ command: string; args: readonly string[] }>;
  children: FakeChild[];
  spawnError?: NodeJS.ErrnoException;
}

let hosts: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.dispose()));
  hosts = [];
});

async function load(settings: Record<string, string | boolean> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "headroom-test-"));
  writeFileSync(join(dataDir, "host-id"), `${SERVER_HOST}\n`);
  const rig: Rig = { up: true, probes: [], spawns: [], children: [] };
  const spawn: SpawnLike = (command, args) => {
    rig.spawns.push({ command, args });
    const child = new FakeChild();
    rig.children.push(child);
    if (rig.spawnError) {
      const error = rig.spawnError;
      queueMicrotask(() => child.emit("error", error));
    }
    return child as unknown as ChildProcess;
  };
  const plugin = createHeadroomPlugin({
    fetch: async (url) => {
      rig.probes.push(url);
      return new Response("{}", { status: rig.up ? 200 : 503 });
    },
    spawn,
    killGraceMs: 50,
    adoptPollMs: 20,
  });
  const fake = createFakePluginHost({ pluginId: "headroom", dataDir, settings });
  await plugin(fake.bb);
  const host = fake.harness;
  hosts.push(host);
  return { host, rig };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

describe("provider routing", () => {
  it("routes Claude Code through the proxy with tool search kept on", async () => {
    const { host, rig } = await load();
    const entries = await host.resolveProviderEnv("claude-code", CONTEXT);
    expect(entries.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8787" },
      { name: "ENABLE_TOOL_SEARCH", value: "true" },
    ]);
    expect(rig.probes).toEqual(["http://127.0.0.1:8787/health"]);
  });

  it("routes Codex to the proxy's /v1 root", async () => {
    const { host } = await load({ url: "http://localhost:9000/" });
    const entries = await host.resolveProviderEnv("codex", CONTEXT);
    expect(entries.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "CODEX_OPENAI_BASE_URL", value: "http://localhost:9000/v1" },
    ]);
  });

  it("leaves other hosts direct", async () => {
    const { host, rig } = await load();
    expect(
      await host.resolveProviderEnv("claude-code", { ...CONTEXT, hostId: "host_remote" }),
    ).toEqual([]);
    expect(rig.probes).toEqual([]);
  });

  it("goes direct while the proxy is not answering", async () => {
    const { host, rig } = await load();
    rig.up = false;
    expect(await host.resolveProviderEnv("claude-code", CONTEXT)).toEqual([]);
    expect(await host.resolveProviderEnv("codex", CONTEXT)).toEqual([]);
  });

  it("honours the per-provider switches and rejects an invalid URL", async () => {
    const { host } = await load({ codex: false });
    expect(await host.resolveProviderEnv("codex", CONTEXT)).toEqual([]);
    expect(await host.resolveProviderEnv("claude-code", CONTEXT)).toHaveLength(2);
    await host.setSettings({ url: "not a url" });
    expect(await host.resolveProviderEnv("claude-code", CONTEXT)).toEqual([]);
  });
});

describe("managed proxy", () => {
  it("starts headroom proxy on the configured loopback port and stops it on dispose", async () => {
    const { host, rig } = await load({ url: "http://127.0.0.1:9123" });
    rig.up = false;
    const run = host.runService("proxy");
    await until(() => rig.children.length === 1);
    expect(rig.spawns[0]).toEqual({
      command: "headroom",
      args: ["proxy", "--host", "127.0.0.1", "--port", "9123"],
    });
    rig.up = true;
    let manager: unknown = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      manager = JSON.parse((await host.runCli(["status", "--json"])).stdout).manager;
      if ((manager as { state: string }).state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(manager).toEqual({ state: "running", pid: 4242 });
    run.controller.abort();
    await run.done;
    expect(rig.children[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("reuses a proxy that is already answering and replaces it when it goes away", async () => {
    const { host, rig } = await load();
    const run = host.runService("proxy");
    await until(() =>
      host.logEntries.some((entry) => entry.message.includes("already answers")),
    );
    expect(rig.spawns).toEqual([]);
    rig.up = false;
    await until(() => rig.spawns.length === 1);
    run.controller.abort();
    await run.done;
  });

  it("asks for installation when the command is missing", async () => {
    const { host, rig } = await load();
    rig.up = false;
    rig.spawnError = Object.assign(new Error("spawn headroom ENOENT"), {
      code: "ENOENT",
    });
    await host.runService("proxy").done;
    expect(host.needsConfigurationMessages[0]).toContain("uv tool install");
  });

  it("fails the service when the proxy exits on its own", async () => {
    const { host, rig } = await load();
    rig.up = false;
    const run = host.runService("proxy");
    await until(() => rig.children.length === 1);
    rig.children[0]?.crash(3);
    await expect(run.done).rejects.toThrow("exited with code 3");
    const status = JSON.parse((await host.runCli(["status", "--json"])).stdout);
    expect(status.manager).toEqual({ state: "exited" });
  });

  it("restarts on a settings change and stops when management is turned off", async () => {
    const { host, rig } = await load();
    rig.up = false;
    const run = host.runService("proxy");
    await until(() => rig.children.length === 1);
    await host.setSettings({ url: "http://127.0.0.1:9999" });
    await until(() => rig.children.length === 2);
    expect(rig.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(rig.spawns[1]?.args).toContain("9999");
    await host.setSettings({ manage: false });
    await until(() => rig.children[1]?.signals.length === 1);
    expect(rig.children).toHaveLength(2);
    run.controller.abort();
    await run.done;
  });

  it("does not start a proxy for a non-loopback URL", async () => {
    const { host, rig } = await load({ url: "http://10.0.0.5:8787" });
    rig.up = false;
    const run = host.runService("proxy");
    await until(() =>
      host.logEntries.some((entry) => entry.message.includes("not loopback")),
    );
    expect(rig.spawns).toEqual([]);
    run.controller.abort();
    await run.done;
  });
});

describe("cli", () => {
  it("reports health and routes", async () => {
    const { host } = await load({ codex: false });
    const result = await host.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      url: "http://127.0.0.1:8787",
      healthy: true,
      manager: { state: "off" },
      routes: { claudeCode: true, codex: false },
      serverHostId: SERVER_HOST,
    });
    const text = await host.runCli(["status"]);
    expect(text.stdout).toContain("Routes:   Claude Code on host host_server");
  });

  it("rejects unknown commands", async () => {
    const { host } = await load();
    expect((await host.runCli(["start"])).exitCode).toBe(2);
  });
});

describe("parseProxyUrl", () => {
  it("normalises and classifies URLs", () => {
    expect(parseProxyUrl("http://[::1]:8787/")).toEqual({
      baseUrl: "http://[::1]:8787",
      host: "::1",
      port: 8787,
      loopback: true,
    });
    expect(parseProxyUrl("https://headroom.example")?.port).toBe(443);
    expect(parseProxyUrl("ftp://x")).toBeNull();
  });
});
