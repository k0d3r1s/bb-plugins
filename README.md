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

The bump is inferred from commit markers, scanning every commit that touched the
plugin since its last tag: a `[major]` or `[minor]` marker in a commit subject
opts into that bump (the highest marker across the range wins), and any normal
commit with no marker cuts a `patch`. `[patch]` is accepted for parity but is
the default. A manual run accepts an explicit `release_type` (`patch`, `minor`,
`major`, or `prerelease`) and an optional single `plugin` to restrict the
release; `prerelease` is reachable only through such a dispatch.

Because every changed plugin cuts at least a stable `patch`, its npm `latest`
always resolves — `npm install @k0d3r1s/bb-plugin-<name>` works after the first
release. A `prerelease` dispatch publishes to the `next` dist-tag instead;
install those with `@next` or an exact version.

Adding a new plugin needs no workflow edits: create `plugins/<name>/` with a
`package.json` (name `@k0d3r1s/bb-plugin-<name>`, `publishConfig.access: public`)
and a `bb` manifest, add it to `.bb/plugins.json`, and CI picks it up.
