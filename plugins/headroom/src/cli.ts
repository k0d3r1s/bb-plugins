import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import { parseProxyUrl, type ManagerState } from "./proxy.js";
import type { HeadroomSettings } from "./settings.js";

export interface HeadroomCliDeps {
  healthy: (baseUrl: string) => Promise<boolean>;
  manager: () => { state: ManagerState; pid?: number };
  serverHostId: () => Promise<string | null>;
}

export function registerHeadroomCli(
  bb: BbPluginApi,
  settings: HeadroomSettings,
  deps: HeadroomCliDeps,
): void {
  bb.cli.register({
    name: "headroom",
    summary: "Inspect the Headroom proxy and bb's routing through it",
    commands: [
      {
        name: "status",
        summary: "Show the proxy URL, its health, and which providers are routed",
        usage: "bb headroom status [--json]",
      },
    ],
    async run(argv): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      if (command !== "status") {
        return { exitCode: 2, stderr: "Usage: bb headroom status [--json]\n" };
      }
      const current = await settings.get();
      const target = parseProxyUrl(current.url);
      const manager = deps.manager();
      const status = {
        url: target?.baseUrl ?? current.url,
        validUrl: target !== null,
        healthy: target !== null && (await deps.healthy(target.baseUrl)),
        manager,
        routes: { claudeCode: current.claude, codex: current.codex },
        serverHostId: await deps.serverHostId(),
      };
      if (rest.includes("--json")) {
        return { exitCode: 0, stdout: `${JSON.stringify(status, null, 2)}\n` };
      }
      const routed = [
        ...(current.claude ? ["Claude Code"] : []),
        ...(current.codex ? ["Codex"] : []),
      ];
      const lines = [
        `Proxy:    ${status.url}${status.validUrl ? "" : " (invalid URL)"}`,
        `Health:   ${status.healthy ? "answering" : "not answering — threads go direct"}`,
        `Manager:  ${manager.state}${manager.pid === undefined ? "" : ` (pid ${manager.pid})`}`,
        `Routes:   ${routed.length > 0 ? routed.join(", ") : "none"} on host ${status.serverHostId ?? "(unknown)"}`,
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });
}
