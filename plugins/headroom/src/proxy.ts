import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface ProxyTarget {
  /** Proxy root without a trailing slash, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Bind address for a managed proxy (IPv6 brackets stripped). */
  host: string;
  port: number;
  loopback: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseProxyUrl(raw: string): ProxyTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    host,
    port,
    loopback: LOOPBACK_HOSTS.has(host),
  };
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export async function probeHealth(
  fetchImpl: FetchLike,
  baseUrl: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ManagerState =
  | "off"
  | "invalid-url"
  | "not-loopback"
  | "adopted"
  | "starting"
  | "running";

export interface SuperviseDeps {
  spawn: SpawnLike;
  healthy: (baseUrl: string) => Promise<boolean>;
  log: { info(message: string): void; debug(message: string): void };
  setState: (state: ManagerState, pid?: number) => void;
  killGraceMs?: number;
  adoptPollMs?: number;
}

export function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keep one `headroom proxy` running for `target` until `signal` aborts. A
 * proxy that already answers `/health` (started by hand, or orphaned by an
 * earlier bb run) is adopted instead of started. Resolves after the child is
 * stopped; rejects when the child exits on its own so the host restarts the
 * service with backoff.
 */
export async function superviseProxy(
  command: string,
  target: ProxyTarget,
  signal: AbortSignal,
  deps: SuperviseDeps,
): Promise<void> {
  if (await deps.healthy(target.baseUrl)) {
    deps.log.info(`Headroom already answers at ${target.baseUrl}; using it.`);
    deps.setState("adopted");
    // Re-check so a reused proxy that goes away gets replaced by our own.
    while (!signal.aborted) {
      await sleep(deps.adoptPollMs ?? 30_000, signal);
      if (!signal.aborted && !(await deps.healthy(target.baseUrl))) {
        deps.log.info(`Headroom stopped answering at ${target.baseUrl}.`);
        return;
      }
    }
    return;
  }
  if (signal.aborted) return;
  const child = deps.spawn(
    command,
    ["proxy", "--host", target.host, "--port", String(target.port)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  deps.setState("starting", child.pid);
  const relay = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) deps.log.debug(`headroom: ${line.trimEnd()}`);
    }
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);

  const exited = new Promise<{ code: number | null; error?: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("exit", (code) => resolve({ code }));
    },
  );
  void waitForHealthy(target.baseUrl, deps, signal, exited).then((up) => {
    if (up) deps.setState("running", child.pid);
  });

  const outcome = await Promise.race([
    exited,
    waitForAbort(signal).then(() => null),
  ]);
  if (outcome === null) {
    await stopChild(child, exited, deps.killGraceMs ?? 5000);
    return;
  }
  if ((outcome.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw needsConfiguration(
      `Headroom command "${command}" was not found. Install it with \`uv tool install "headroom-ai[all]"\` (or set the command setting to its absolute path), then run \`bb plugin reload headroom\`.`,
    );
  }
  throw new Error(
    outcome.error
      ? `headroom proxy failed to start: ${outcome.error.message}`
      : `headroom proxy exited with code ${outcome.code}`,
  );
}

async function waitForHealthy(
  baseUrl: string,
  deps: SuperviseDeps,
  signal: AbortSignal,
  exited: Promise<unknown>,
): Promise<boolean> {
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  while (!gone && !signal.aborted) {
    if (await deps.healthy(baseUrl)) return !gone && !signal.aborted;
    await sleep(500, signal);
  }
  return false;
}

async function stopChild(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), graceMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}
