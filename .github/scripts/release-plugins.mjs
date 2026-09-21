import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const matrix = JSON.parse(process.env.MATRIX ?? "[]");
if (matrix.length === 0) {
  console.log("No plugins to release.");
  process.exit(0);
}

if (!(process.env.NODE_AUTH_TOKEN ?? "").trim()) {
  console.log(
    "NODE_AUTH_TOKEN (NPM_TOKEN secret) is not set — skipping release. " +
      "Add the NPM_TOKEN repository secret, then push a bump or run the workflow manually.",
  );
  process.exit(0);
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

const released = [];
for (const { id, dir, bump } of matrix) {
  console.log(`\n=== ${id}: ${bump} ===`);
  run("npm", ["install", "--include=dev", "--legacy-peer-deps"], dir);
  run("npm", ["run", "test"], dir);
  run("bb", ["plugin", "build"], dir);

  const versionArgs = ["version", bump, "--no-git-tag-version"];
  if (bump === "prerelease") versionArgs.push("--preid", "beta");
  run("npm", versionArgs, dir);

  const version = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;
  const prerelease = version.includes("-");

  const publishArgs = ["publish", "--access", "public"];
  if (prerelease) publishArgs.push("--tag", "next");
  run("npm", publishArgs, dir);

  const tag = `${id}/v${version}`;
  run("git", ["add", `${dir}/package.json`]);
  released.push({ id, version, tag, prerelease });
}

if (released.length === 0) process.exit(0);

const summary = released.map((r) => `${r.id} v${r.version}`).join(", ");
run("git", ["commit", "-m", `release: ${summary}`]);
for (const r of released) run("git", ["tag", "-a", r.tag, "-m", `${r.id} v${r.version}`]);
run("git", ["push", "origin", "HEAD:main"]);
run("git", ["push", "origin", "--tags"]);

for (const r of released) {
  const args = ["release", "create", r.tag, "--title", `${r.id} v${r.version}`, "--notes", `Release ${r.id} v${r.version}.`];
  if (r.prerelease) args.push("--prerelease");
  run("gh", args);
}

console.log(`\nReleased: ${summary}`);
