# bb-plugins

A monorepo of [bb](https://getbb.app) plugins. Each plugin is a self-contained
package under `plugins/<name>/` with its own `package.json` and `bb` manifest.
The root [`.bb/plugins.json`](.bb/plugins.json) collection manifest indexes them.

## Plugins

| Plugin | ID | npm |
|---|---|---|
| Auto review | `auto-review` | `@k0d3r1s/bb-plugin-auto-review` |

## Install a plugin

From npm (per-plugin, tracks compatible releases):

```sh
bb plugin install npm:@k0d3r1s/bb-plugin-auto-review
```

From this repo over git (select one plugin from the collection):

```sh
bb plugin install git:https://github.com/k0d3r1s/bb-plugins.git --plugin auto-review
# or the primitive, no collection manifest needed:
bb plugin install git:https://github.com/k0d3r1s/bb-plugins.git --subdirectory plugins/auto-review
```

## Local development

Each plugin builds standalone with the `bb` CLI (shipped in the public `bb-app`
npm package). From a plugin directory:

```sh
npm install --include=dev --legacy-peer-deps
npm test
bb plugin build          # downloads the build toolchain on first use
```

`--legacy-peer-deps` sidesteps an npm arborist bug in vitest 4's optional peer
graph. The bb plugin SDK declares its server-side deps (`better-sqlite3`,
`cron-parser`, `hono`) as optional peers; a plugin whose tests use the SDK test
harness lists them as devDependencies.

## Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml).
On push to `master` (or a manual run), CI discovers every plugin under `plugins/`,
releases only those whose sources changed since their last tag, bumps the
version, tags `<plugin>/vX.Y.Z`, publishes to npm, and creates a GitHub Release.

Control the bump per plugin with a marker in the commit subject — `[major]`,
`[minor]`, or `[patch]`; with none, CI cuts a `prerelease` (published to npm
under the `next` dist-tag). A manual run accepts an explicit `release_type` and
an optional single `plugin` to restrict the release.

**A stable `latest` release requires a marker or a dispatch.** Prereleases go to
the `next` dist-tag only, so until a plugin has had at least one
`[patch]`/`[minor]`/`[major]` (or a `workflow_dispatch` with `release_type`)
release, `npm install @k0d3r1s/bb-plugin-<name>` (which resolves `latest`) finds
nothing — install a prerelease explicitly with `@next` or an exact version, or
cut a stable release first.

Adding a new plugin needs no workflow edits: create `plugins/<name>/` with a
`package.json` (name `@k0d3r1s/bb-plugin-<name>`, `publishConfig.access: public`)
and a `bb` manifest, add it to `.bb/plugins.json`, and CI picks it up.
