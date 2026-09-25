import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BbPluginApi,
  ExperimentalPluginProviderEnvContext,
  ExperimentalPluginProviderEnvEntry,
} from "@get-bb/plugin-sdk";
import { registerHeadroomCli } from "./src/cli.js";
import {
  parseProxyUrl,
  probeHealth,
  superviseProxy,
  waitForAbort,
  type FetchLike,
  type ManagerState,
  type SpawnLike,
} from "./src/proxy.js";
import { defineHeadroomSettings } from "./src/settings.js";

export interface HeadroomPluginOptions {
  fetch?: FetchLike;
  spawn?: SpawnLike;
  killGraceMs?: number;
  adoptPollMs?: number;
}

type Provider = "claude" | "codex";

export function createHeadroomPlugin(options: HeadroomPluginOptions = {}) {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const spawnImpl = options.spawn ?? nodeSpawn;
  const healthy = (baseUrl: string) => probeHealth(fetchImpl, baseUrl);

  return async function headroomPlugin(bb: BbPluginApi): Promise<void> {
    const settings = defineHeadroomSettings(bb);

    let manager: { state: ManagerState; pid?: number } = { state: "off" };
    const settingsChanged = new Set<() => void>();
    settings.onChange(() => {
      for (const listener of [...settingsChanged]) listener();
    });

    const serverHostId = async (): Promise<string | null> => {
      try {
        const id = await readFile(
          join(bb.server.experimental_dataDir, "host-id"),
          "utf8",
        );
        return id.trim() || null;
      } catch {
        return null;
      }
    };

    const routeFor =
      (
        provider: Provider,
        entries: (baseUrl: string) => ExperimentalPluginProviderEnvEntry[],
      ) =>
      async (
        context: ExperimentalPluginProviderEnvContext,
      ): Promise<ExperimentalPluginProviderEnvEntry[]> => {
        const current = await settings.get();
        if (!current[provider]) return [];
        const target = parseProxyUrl(current.url);
        if (target === null) return [];
        // The URL is resolved on the bb server's machine; other hosts can't
        // be assumed to reach it (a loopback URL certainly isn't theirs).
        if (context.hostId !== (await serverHostId())) return [];
        if (!(await healthy(target.baseUrl))) {
          bb.log.debug(
            `Headroom is not answering at ${target.baseUrl}; thread ${context.threadId} goes direct.`,
          );
          return [];
        }
        return entries(target.baseUrl);
      };

    bb.providers.experimental_contributeEnv(
      "claude-code",
      routeFor("claude", (baseUrl) => [
        {
          name: "ANTHROPIC_BASE_URL",
          value: baseUrl,
          reason: "Routed through the Headroom compression proxy",
        },
        {
          name: "ENABLE_TOOL_SEARCH",
          value: "true",
          reason:
            "Claude Code turns tool search off behind a custom base URL; keep deferred tool loading on",
        },
      ]),
    );
    bb.providers.experimental_contributeEnv(
      "codex",
      routeFor("codex", (baseUrl) => [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: `${baseUrl}/v1`,
          reason: "Routed through the Headroom compression proxy",
        },
      ]),
    );

    bb.background.service("proxy", {
      async start(signal) {
        while (!signal.aborted) {
          const generation = new AbortController();
          const stop = () => generation.abort();
          signal.addEventListener("abort", stop, { once: true });
          settingsChanged.add(stop);
          try {
            const current = await settings.get();
            const target = parseProxyUrl(current.url);
            if (!current.manage) {
              manager = { state: "off" };
            } else if (target === null) {
              manager = { state: "invalid-url" };
              bb.log.warn(`Headroom proxy URL "${current.url}" is not a valid http(s) URL.`);
            } else if (!target.loopback) {
              manager = { state: "not-loopback" };
              bb.log.info(
                `Headroom proxy URL ${target.baseUrl} is not loopback; not starting a local proxy.`,
              );
            } else {
              await superviseProxy(current.command, target, generation.signal, {
                spawn: spawnImpl,
                healthy,
                log: bb.log,
                setState: (state, pid) => {
                  manager = { state, ...(pid === undefined ? {} : { pid }) };
                },
                ...(options.killGraceMs === undefined
                  ? {}
                  : { killGraceMs: options.killGraceMs }),
                ...(options.adoptPollMs === undefined
                  ? {}
                  : { adoptPollMs: options.adoptPollMs }),
              });
              continue;
            }
            await waitForAbort(generation.signal);
          } finally {
            signal.removeEventListener("abort", stop);
            settingsChanged.delete(stop);
          }
        }
        manager = { state: "off" };
      },
    });

    registerHeadroomCli(bb, settings, {
      healthy,
      manager: () => manager,
      serverHostId,
    });
  };
}

export default createHeadroomPlugin();
