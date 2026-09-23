import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachManifest,
  createRegistry,
  defaultRuntimeRoot,
  loadPolicy,
  loadRegistry,
  policyPathFor,
  projectsDirectory,
  RUNTIME_ROOT_NAME,
  validatePolicyDocument,
} from "../src/registry.mjs";

const DIGEST = "a".repeat(64);

function policyDocument(overrides = {}) {
  return {
    projectId: "proj_alpha",
    trustedHostId: "host_local",
    primaryRoot: "/workspace/alpha",
    worktreeRoot: "/bb/worktrees",
    worktreeDirectoryName: "alpha",
    gitCommonDir: "/workspace/alpha/.git",
    dockerPath: "/usr/local/bin/docker",
    manifestSha256: DIGEST,
    containers: { app: "alpha_app" },
    ...overrides,
  };
}

async function makeRuntimeRoot(t) {
  const fixtureRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "shared-runtime-registry-")),
  );
  t.after(async () => {
    await chmod(path.join(fixtureRoot, "runtime", "projects"), 0o700).catch(() => {});
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const runtimeRoot = path.join(fixtureRoot, "runtime");
  await mkdir(projectsDirectory(runtimeRoot), { recursive: true, mode: 0o700 });
  return { fixtureRoot, runtimeRoot };
}

async function writePolicy(runtimeRoot, document, { mode = 0o600, name } = {}) {
  const target = path.join(
    projectsDirectory(runtimeRoot),
    name ?? `${document.projectId}.json`,
  );
  await writeFile(target, `${JSON.stringify(document)}\n`, { mode });
  await chmod(target, mode);
  return target;
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const fakeManifest = Object.freeze({ version: 1, containers: {} });

test("runtime root paths derive from the home directory and validated project ids", () => {
  assert.equal(RUNTIME_ROOT_NAME, "shared-runtime");
  assert.equal(defaultRuntimeRoot(), path.join(homedir(), ".bb", "shared-runtime"));
  assert.equal(projectsDirectory("/r"), path.join("/r", "projects"));
  assert.equal(policyPathFor("proj_abc123", "/r"), path.join("/r", "projects", "proj_abc123.json"));
  for (const invalid of ["proj_", "proj_../x", "project_abc", "proj_a/b", "../proj_a"]) {
    assert.throws(
      () => policyPathFor(invalid, "/r"),
      /Shared runtime denied: project id is invalid/,
      invalid,
    );
  }
});

test("a complete policy document with every optional field validates unchanged", () => {
  const document = policyDocument({
    dockerSocket: "/var/run/docker.sock",
    manifestPath: "/trusted/manifest.json",
    composeProject: "alpha_dev.1-x",
    bbCli: "/usr/local/bin/bb",
    containers: { app: "alpha_app", "db-2": "alpha.db-2" },
  });
  assert.equal(validatePolicyDocument(document), document);
  const nulled = policyDocument({
    dockerSocket: null,
    manifestPath: null,
    composeProject: null,
    bbCli: null,
  });
  assert.equal(validatePolicyDocument(nulled), nulled);
  // Entries installed before CodeGraph was retired keep loading; the keys are
  // ignored, even in shapes the old validator refused.
  const legacy = policyDocument({ codegraphCommand: "bin/codegraph", codegraphRoot: "" });
  assert.equal(validatePolicyDocument(legacy), legacy);
});

test("policy document validation rejects each malformed field with a specific reason", () => {
  const requiredFields = [
    "projectId",
    "trustedHostId",
    "primaryRoot",
    "worktreeRoot",
    "worktreeDirectoryName",
    "gitCommonDir",
    "dockerPath",
    "manifestSha256",
  ];
  for (const field of requiredFields) {
    for (const value of [undefined, "", "   ", 42]) {
      assert.throws(
        () => validatePolicyDocument(policyDocument({ [field]: value })),
        new RegExp(`^Error: Shared runtime denied: policy ${field} is missing or invalid$`),
        `${field}=${JSON.stringify(value)}`,
      );
    }
  }

  const cases = [
    [{ projectId: "project_1" }, /policy projectId is invalid/],
    [{ trustedHostId: "hst_1" }, /policy trustedHostId is invalid/],
    [{ worktreeDirectoryName: "." }, /policy worktreeDirectoryName is invalid/],
    [{ worktreeDirectoryName: ".." }, /policy worktreeDirectoryName is invalid/],
    [{ worktreeDirectoryName: "a\0b" }, /policy worktreeDirectoryName is invalid/],
    [{ worktreeDirectoryName: "a/b" }, /policy worktreeDirectoryName is invalid/],
    [{ manifestSha256: "A".repeat(64) }, /policy manifestSha256 is invalid/],
    [{ primaryRoot: "relative/root" }, /policy roots must be absolute/],
    [{ worktreeRoot: "relative/worktrees" }, /policy roots must be absolute/],
    [{ gitCommonDir: "relative/.git" }, /executable and repository paths must be absolute/],
    [{ dockerSocket: "" }, /policy Docker socket is missing or invalid/],
    [{ dockerSocket: "docker.sock" }, /policy Docker socket must be absolute/],
    [{ manifestPath: " " }, /policy manifest path is missing or invalid/],
    [{ composeProject: "" }, /policy Compose project is missing or invalid/],
    [{ composeProject: "has space" }, /policy Compose project is invalid/],
    [{ composeProject: "null" }, /policy Compose project is invalid/],
    [{ containers: null }, /containers must map roles to container names/],
    [{ containers: ["alpha_app"] }, /containers must map roles to container names/],
    [{ containers: "alpha_app" }, /containers must map roles to container names/],
    [{ containers: { App: "alpha_app" } }, /policy container role "App" is invalid/],
    [{ containers: { app: "-alpha" } }, /policy container app name is invalid/],
    [{ containers: { app: 7 } }, /policy container app name is invalid/],
    [{ bbCli: "" }, /policy BB CLI is missing or invalid/],
    [{ bbCli: "bin/bb" }, /policy BB CLI must be absolute/],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(
      () => validatePolicyDocument(policyDocument(overrides)),
      expected,
      JSON.stringify(overrides),
    );
  }
});

test("policy loading refuses relative paths, missing anchors, and unsafe descriptors", async (t) => {
  const { fixtureRoot, runtimeRoot } = await makeRuntimeRoot(t);
  const projectsRoot = projectsDirectory(runtimeRoot);
  const policyPath = path.join(projectsRoot, "proj_alpha.json");

  await assert.rejects(
    loadPolicy("relative/proj_alpha.json"),
    /policy path or current user identity is invalid/,
  );
  await assert.rejects(
    loadPolicy(path.join(fixtureRoot, "absent", "projects", "proj_alpha.json")),
    /policy runtime directory is missing/,
  );
  await assert.rejects(loadPolicy(policyPath), /policy file is missing or not a regular file/);

  await writePolicy(runtimeRoot, policyDocument(), { mode: 0o644 });
  await assert.rejects(
    loadPolicy(policyPath),
    /policy file has unsafe identity, links, or permissions/,
  );

  await writePolicy(runtimeRoot, policyDocument());
  const loaded = await loadPolicy(policyPath);
  assert.equal(loaded.projectId, "proj_alpha");
  assert.equal(loaded.runtimeRoot, runtimeRoot);
  assert.equal(Object.isFrozen(loaded), true);

  await writeFile(policyPath, "{ not json", { mode: 0o600 });
  await assert.rejects(loadPolicy(policyPath), SyntaxError);

  await writePolicy(runtimeRoot, policyDocument({ trustedHostId: "nope" }));
  await assert.rejects(loadPolicy(policyPath), /policy trustedHostId is invalid/);

  await chmod(runtimeRoot, 0o755);
  await assert.rejects(
    loadPolicy(policyPath),
    /policy runtime directory has unsafe identity or permissions/,
  );
  await chmod(runtimeRoot, 0o700);

  const linkedRuntime = path.join(fixtureRoot, "linked-runtime");
  await symlink(runtimeRoot, linkedRuntime);
  await assert.rejects(
    loadPolicy(path.join(linkedRuntime, "projects", "proj_alpha.json")),
    /policy runtime directory has unsafe identity or permissions/,
  );
});

test("attachManifest records digest drift and read failures without throwing", async () => {
  const policy = Object.freeze(policyDocument());
  const current = await attachManifest(policy, {
    readManifestFile: async (primaryRoot, manifestPath) => {
      assert.equal(primaryRoot, "/workspace/alpha");
      assert.equal(manifestPath, undefined);
      return { manifest: fakeManifest, digest: DIGEST };
    },
  });
  assert.equal(current.manifest, fakeManifest);
  assert.equal(current.manifestDigest, DIGEST);
  assert.equal(current.manifestStale, false);
  assert.equal(current.manifestError, null);
  assert.equal(Object.isFrozen(current), true);

  const drifted = await attachManifest(policy, {
    readManifestFile: async () => ({ manifest: fakeManifest, digest: "b".repeat(64) }),
  });
  assert.equal(drifted.manifestStale, true);
  assert.equal(drifted.manifestError, null);

  const failed = await attachManifest(policy, {
    readManifestFile: async () => {
      throw "plain string failure";
    },
  });
  assert.equal(failed.manifest, null);
  assert.equal(failed.manifestDigest, null);
  assert.equal(failed.manifestStale, true);
  assert.equal(failed.manifestError, "plain string failure");

  const missing = await attachManifest(policy);
  assert.match(missing.manifestError, /manifest missing: \/workspace\/alpha\/\.bb-runtime\.json/);
});

test("registry loading skips foreign entries and surfaces unreadable projects directories", async (t) => {
  const { fixtureRoot, runtimeRoot } = await makeRuntimeRoot(t);
  const projectsRoot = projectsDirectory(runtimeRoot);
  await writePolicy(runtimeRoot, policyDocument());
  await writePolicy(runtimeRoot, policyDocument(), { name: "notes.json" });
  await writePolicy(runtimeRoot, policyDocument(), { name: "proj_alpha.json.tmp-1" });
  await mkdir(path.join(projectsRoot, "proj_dir.json"));
  await writePolicy(runtimeRoot, policyDocument({ projectId: "proj_beta", containers: {} }));

  const registry = await loadRegistry(runtimeRoot, {
    readManifestFile: async () => ({ manifest: fakeManifest, digest: DIGEST }),
  });
  assert.deepEqual([...registry.policies.keys()], ["proj_alpha"]);
  assert.deepEqual(registry.problems, [
    {
      path: path.join(projectsRoot, "proj_beta.json"),
      message: "Shared runtime denied: policy containers must map roles to container names",
    },
  ]);

  const fileRoot = path.join(fixtureRoot, "file-root");
  await mkdir(fileRoot);
  await writeFile(path.join(fileRoot, "projects"), "not a directory\n");
  await assert.rejects(loadRegistry(fileRoot), { code: "ENOTDIR" });
});

test("a live registry loads, watches, refreshes once per burst, and disposes", async (t) => {
  const { runtimeRoot } = await makeRuntimeRoot(t);
  const projectsRoot = projectsDirectory(runtimeRoot);
  await writePolicy(runtimeRoot, policyDocument());
  await writePolicy(runtimeRoot, policyDocument({ projectId: "proj_broken", containers: [] }));

  const warnings = [];
  let manifestReads = 0;
  const registry = createRegistry({
    runtimeRoot,
    log: { warn: (message) => warnings.push(message) },
    readManifestFile: async () => {
      manifestReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { manifest: fakeManifest, digest: DIGEST };
    },
  });
  t.after(() => registry.dispose());

  const loaded = await registry.load();
  assert.deepEqual([...loaded.keys()], ["proj_alpha"]);
  assert.equal(registry.policyFor("proj_alpha").primaryRoot, "/workspace/alpha");
  assert.equal(registry.policyFor("proj_missing"), null);
  assert.deepEqual(
    registry.entries().map((entry) => entry.projectId),
    ["proj_alpha"],
  );
  const problems = registry.problems();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, path.join(projectsRoot, "proj_broken.json"));
  problems.pop();
  assert.equal(registry.problems().length, 1, "problems() returns a defensive copy");
  assert.deepEqual(warnings, [
    `shared runtime registry entry skipped: ${path.join(projectsRoot, "proj_broken.json")}: Shared runtime denied: policy containers must map roles to container names`,
  ]);

  manifestReads = 0;
  const [first, second] = await Promise.all([registry.refresh(), registry.refresh()]);
  assert.equal(first, second, "overlapping refreshes share one load");
  assert.equal(manifestReads, 1);

  await rm(path.join(projectsRoot, "proj_broken.json"));
  await writePolicy(runtimeRoot, policyDocument({ projectId: "proj_gamma" }));
  await waitFor(
    () => registry.policyFor("proj_gamma") !== null,
    "the watcher to pick up a new policy",
  );
  assert.deepEqual(
    registry.entries().map((entry) => entry.projectId).sort(),
    ["proj_alpha", "proj_gamma"],
  );
  assert.deepEqual(registry.problems(), []);

  await registry.load();
  registry.dispose();
  assert.deepEqual(registry.entries(), []);
  assert.equal(registry.policyFor("proj_alpha"), null);
});

test("a live registry logs failed background refreshes and tolerates a missing directory", async (t) => {
  const { fixtureRoot, runtimeRoot } = await makeRuntimeRoot(t);
  const projectsRoot = projectsDirectory(runtimeRoot);
  const warnings = [];
  const registry = createRegistry({
    runtimeRoot,
    log: { warn: (message) => warnings.push(message) },
    readManifestFile: async () => ({ manifest: fakeManifest, digest: DIGEST }),
  });
  t.after(() => registry.dispose());
  await registry.load();
  assert.deepEqual(registry.entries(), []);

  await writePolicy(runtimeRoot, policyDocument());
  await chmod(projectsRoot, 0o000);
  try {
    await waitFor(
      () => warnings.some((message) => message.startsWith("shared runtime registry refresh failed:")),
      "the failed refresh warning",
    );
  } finally {
    await chmod(projectsRoot, 0o700);
  }
  assert.match(
    warnings.find((message) => message.includes("refresh failed")),
    /EACCES/,
  );

  const absentRegistry = createRegistry({
    runtimeRoot: path.join(fixtureRoot, "never-created"),
  });
  const absent = await absentRegistry.load();
  assert.equal(absent.size, 0);
  assert.deepEqual(absentRegistry.problems(), []);
  absentRegistry.dispose();
});
