import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runAgentHooksCli } from "./src/cli.mjs";
import { sync, verifyChecksums } from "./src/sync.mjs";
import { INSTALL_DIR } from "./src/wire.mjs";

/**
 * bb owns the tool-call safety hooks; providers only execute them.
 *
 * bb cannot run these itself. Its only veto checkpoint is
 * experimental_hooks.on("message.dispatch") -- message admission -- and bb.events
 * handlers are explicitly fire-and-forget and "can never block or veto". There is
 * no tool-call hook in the SDK, so a hook runs only if the provider's own config
 * references it. That pointer is irreducible; everything else stays on bb's side:
 * the scripts live under ~/.bb/agent-hooks, no plugin is installed into any
 * provider's plugin manager, and no file is copied into a provider directory.
 */
export default async function plugin(bb: BbPluginApi) {
  // Keep the install dir current on every load, including after an auto-update
  // pulls a new sha and the daemon reloads this plugin. Without it, a fix to a
  // hook would sit unused until someone remembered to re-run install.
  //
  // Only the file copy is automatic. Provider-config writes stay manual: they
  // touch files bb does not own, and a surprise edit to ~/.claude/settings.json
  // is not something a plugin load should do.
  try {
    verifyChecksums();
    const changed = sync();
    if (changed.length > 0) {
      const overwritten = changed.filter((c: { overwrote: boolean }) => c.overwrote);
      bb.log.info(`agent-hooks: synced ${changed.length} script(s) to ${INSTALL_DIR}`);
      if (overwritten.length > 0) {
        // Named rather than silent: the install dir is what actually executes, so
        // a hand-edit made while debugging a hook would otherwise vanish here
        // with no trace.
        bb.log.warn(
          `agent-hooks: overwrote locally modified script(s): ${overwritten
            .map((c: { name: string }) => c.name)
            .join(", ")}`,
        );
      }
    }
  } catch (error) {
    bb.log.error(
      `agent-hooks: hook sync failed, leaving the installed copies untouched: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  bb.cli.register({
    name: "agent-hooks",
    summary: "Install and verify the tool-call safety hooks bb owns for each provider",
    commands: [
      {
        name: "install",
        summary: "Wire the hooks into each provider's config",
        usage: "bb agent-hooks install [--provider <id>] [--dry-run]",
      },
      {
        name: "status",
        summary: "Show per-provider drift; --probe verifies the hooks actually respond",
        usage: "bb agent-hooks status [--provider <id>] [--probe]",
      },
      {
        name: "uninstall",
        summary: "Remove only our entries from each provider's config",
        usage: "bb agent-hooks uninstall [--provider <id>]",
      },
      {
        name: "log",
        summary: "Recent hook firings from the current project's incident log",
        usage: "bb agent-hooks log [--limit <n>]",
      },
    ],
    run: (argv: string[]) => runAgentHooksCli(argv),
  });
}
