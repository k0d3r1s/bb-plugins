import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

// INSTALL_DIR and the provider config paths are derived from os.homedir() at
// import time. Point HOME at a throwaway directory before server.ts (and the
// modules it imports) load, so a plugin load here can never sync into the real
// ~/.bb/agent-hooks or read the real provider configs.
const { fakeHome, realHome } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  const realHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(p.join(os.tmpdir(), "server-test-home-"));
  process.env.HOME = fakeHome;
  return { fakeHome, realHome };
});

// Real sync by default; wrapped so one test can make it throw a non-Error.
vi.mock("./src/sync.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("./src/sync.mjs")>();
  return { ...real, verifyChecksums: vi.fn(real.verifyChecksums) };
});

import plugin from "./server.js";
import { hookScripts, SOURCE_DIR, verifyChecksums } from "./src/sync.mjs";
import { INSTALL_DIR } from "./src/wire.mjs";

function load() {
  const host = createFakePluginHost({ pluginId: "agent-hooks" });
  return plugin(host.bb).then(() => host);
}

const logs = (host: Awaited<ReturnType<typeof load>>, level: string) =>
  host.harness.logEntries.filter((e) => e.level === level).map((e) => e.message);

beforeEach(() => {
  if (!INSTALL_DIR.startsWith(fakeHome)) throw new Error(`INSTALL_DIR escaped the fake HOME: ${INSTALL_DIR}`);
  rmSync(fakeHome, { recursive: true, force: true });
  mkdirSync(fakeHome, { recursive: true });
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  process.env.HOME = realHome;
});

describe("plugin load: script sync", () => {
  it("copies the hooks into the install dir and says so", async () => {
    const host = await load();
    expect(logs(host, "info")).toEqual([`agent-hooks: synced ${hookScripts().length} script(s) to ${INSTALL_DIR}`]);
    expect(logs(host, "warn")).toEqual([]);
    expect(logs(host, "error")).toEqual([]);
    for (const s of hookScripts()) {
      expect(readFileSync(path.join(INSTALL_DIR, s), "utf8")).toBe(readFileSync(path.join(SOURCE_DIR, s), "utf8"));
    }
  });

  it("stays silent when the install dir is already current", async () => {
    await load();
    const host = await load();
    expect(host.harness.logEntries).toEqual([]);
  });

  it("warns by name when it overwrites a hand-edited install copy", async () => {
    await load();
    writeFileSync(path.join(INSTALL_DIR, "guard-bash.sh"), "# debugging\n");
    writeFileSync(path.join(INSTALL_DIR, "secret-scan.sh"), "# debugging\n");
    const host = await load();
    expect(logs(host, "info")).toEqual([`agent-hooks: synced 2 script(s) to ${INSTALL_DIR}`]);
    expect(logs(host, "warn")).toEqual([
      "agent-hooks: overwrote locally modified script(s): guard-bash.sh, secret-scan.sh",
    ]);
  });

  it("does not warn when it only fills in a missing script", async () => {
    await load();
    rmSync(path.join(INSTALL_DIR, "session-reset.sh"));
    const host = await load();
    expect(logs(host, "info")).toEqual([`agent-hooks: synced 1 script(s) to ${INSTALL_DIR}`]);
    expect(logs(host, "warn")).toEqual([]);
  });

  it("logs a failed sync, leaves nothing half-written, and still registers the CLI", async () => {
    writeFileSync(path.join(fakeHome, ".bb"), "a file where the directory should be");
    const host = await load();
    const [error] = logs(host, "error");
    expect(error).toMatch(/^agent-hooks: hook sync failed, leaving the installed copies untouched: .*(ENOTDIR|EEXIST)/);
    expect(logs(host, "info")).toEqual([]);
    expect(host.harness.registrations.cli?.name).toBe("agent-hooks");
  });

  it("refuses to sync when the integrity check fails, and stringifies a non-Error throw", async () => {
    vi.mocked(verifyChecksums).mockImplementationOnce(() => {
      throw "tampered";
    });
    const host = await load();
    expect(logs(host, "error")).toEqual([
      "agent-hooks: hook sync failed, leaving the installed copies untouched: tampered",
    ]);
    expect(existsSync(INSTALL_DIR)).toBe(false);
  });
});

describe("plugin load: CLI", () => {
  it("registers `bb agent-hooks` with its four subcommands", async () => {
    const host = await load();
    const cli = host.harness.registrations.cli!;
    expect(cli.name).toBe("agent-hooks");
    expect(cli.summary).toMatch(/safety hooks/);
    expect(cli.commands.map((c) => c.name)).toEqual(["install", "status", "uninstall", "log"]);
    for (const c of cli.commands) expect(c.usage).toMatch(new RegExp(`^bb agent-hooks ${c.name}`));
  });

  it("routes argv to the agent-hooks CLI with host semantics", async () => {
    const host = await load();
    const status = await host.harness.runCli(["status", "--provider", "claude-code"]);
    // Scripts were synced on load, but no provider config is wired yet.
    expect(status.exitCode).toBe(1);
    expect(status.stdout).toContain("claude-code  0/");
    expect(status.stdout).toContain("scripts current");

    const bogus = await host.harness.runCli(["bogus"]);
    expect(bogus.exitCode).toBe(1);
    expect(bogus.stdout).toContain("unknown subcommand 'bogus'");

    const bad = await host.harness.runCli(["status", "--provider", "nope"]);
    expect(bad).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unknown provider 'nope'") });
  });

  it("install through the host writes only into the fake HOME", async () => {
    const host = await load();
    const r = await host.harness.runCli(["install", "--provider", "claude-code"]);
    expect(r.exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(settings)).toContain(path.join(INSTALL_DIR, "guard-bash.sh"));
  });
});
