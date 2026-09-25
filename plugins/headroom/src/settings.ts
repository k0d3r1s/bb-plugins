import type { BbPluginApi } from "@get-bb/plugin-sdk";

export function defineHeadroomSettings(bb: BbPluginApi) {
  return bb.settings.define({
    url: {
      type: "string",
      label: "Proxy URL",
      description:
        "Root URL of the Headroom proxy, without /v1. Claude Code gets it as ANTHROPIC_BASE_URL and Codex gets <url>/v1.",
      default: "http://127.0.0.1:8787",
    },
    manage: {
      type: "boolean",
      label: "Run the proxy",
      description:
        "Start `headroom proxy` with bb and stop it on disable or shutdown. Needs a loopback URL; a proxy already answering there is reused.",
      default: true,
    },
    command: {
      type: "string",
      label: "Headroom command",
      description:
        "Executable used to start the proxy. Set an absolute path when bb's PATH does not include it.",
      default: "headroom",
    },
    claude: {
      type: "boolean",
      label: "Route Claude Code",
      description: "Send Claude Code threads through Headroom.",
      default: true,
    },
    codex: {
      type: "boolean",
      label: "Route Codex",
      description:
        "Send Codex threads through Headroom. Needs a bb build whose Codex bridge accepts CODEX_OPENAI_BASE_URL without an Account Pooler token.",
      default: true,
    },
  });
}

export type HeadroomSettings = ReturnType<typeof defineHeadroomSettings>;
