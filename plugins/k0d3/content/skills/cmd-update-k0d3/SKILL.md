---
name: cmd-update-k0d3
description: Command — Force a fresh load of k0d3 after pushing changes — refresh the valksor-k0d3 marketplace and reinstall
---

# /update-k0d3

Forces Claude Code to re-read k0d3 by refreshing its marketplace and reinstalling. Use after pushing changes to the k0d3 repo, or whenever you suspect CC has cached an older version.

The marketplace/uninstall/install steps are Claude Code meta-commands (slash commands typed in the chat) — they are NOT shell commands. Only the verification step shells out (`/help | grep`).

## Prerequisite

k0d3 installs from the **`valksor-k0d3`** marketplace, which sources `github.com/valksor/k0d3`. Your changes must already be **pushed to GitHub** (e.g. `git push origin master` from the dev clone) — the steps below fetch from the marketplace, not from any local working tree.

## Steps

1. **Refresh the marketplace** (CC slash command) so the latest pushed commit becomes available:
   ```
   /plugin marketplace update valksor-k0d3
   ```
2. **Uninstall** (CC slash command):
   ```
   /plugin uninstall k0d3
   ```
3. **Reinstall from the marketplace** (CC slash command):
   ```
   /plugin install k0d3@valksor-k0d3
   ```
4. **Verify** (this one is a shell command — `/help` here means CC's help output piped to grep):
   ```bash
   # Run inside Claude Code:
   /help | grep -i k0d3
   ```
   You should see the k0d3 commands listed. If you don't, the install didn't take — re-run step 1 and confirm the marketplace name with `/plugin marketplace list`.

## Resolution policy

Installs from **`@valksor-k0d3`** (the GitHub marketplace for `valksor/k0d3`). Step 1 is what actually pulls new commits — without it, an uninstall/reinstall just restores the previously cached version. There is no `@local` marketplace in this setup.
