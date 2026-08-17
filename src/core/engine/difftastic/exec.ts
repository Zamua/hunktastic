/**
 * Subprocess wrapper for the difftastic binary. Every invocation sets
 * `DFT_UNSTABLE=yes` (the JSON display is gated behind it) and translates
 * spawn failures into typed results so callers can walk the fallback ladder
 * without catching.
 */

/** PATH-resolved default; overridable via the `difft_path` config key. */
export const DEFAULT_DIFFT_PATH = "difft";

/** Per-file invocation budget; a slower file falls back to Pierre. */
export const DIFFT_TIMEOUT_MS = 5000;

export interface DifftasticExecError {
  kind: "missing-binary" | "nonzero-exit" | "timeout";
  detail: string;
  exitCode?: number;
}

export type DifftasticExecResult =
  | { ok: true; stdout: string }
  | { ok: false; error: DifftasticExecError };

export interface DifftasticExecOptions {
  difftPath?: string;
  timeoutMs?: number;
}

/** Match Bun's spawn throw for a binary that does not exist (PATH lookup or explicit path). */
function isMissingExecutableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Executable not found in $PATH") || error.message.includes("ENOENT")
  );
}

/** Spawn one difft invocation and normalize every failure mode into a typed result. */
function spawnDifft(args: string[], options: DifftasticExecOptions = {}): DifftasticExecResult {
  const difftPath = options.difftPath ?? DEFAULT_DIFFT_PATH;
  const timeoutMs = options.timeoutMs ?? DIFFT_TIMEOUT_MS;

  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync([difftPath, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DFT_UNSTABLE: "yes" },
      timeout: timeoutMs,
    });
  } catch (error) {
    if (isMissingExecutableError(error)) {
      return {
        ok: false,
        error: { kind: "missing-binary", detail: `${difftPath}: not found` },
      };
    }

    return {
      ok: false,
      error: {
        kind: "nonzero-exit",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const stdout = Buffer.from(proc.stdout ?? []).toString("utf8");
  const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");

  if (proc.exitedDueToTimeout) {
    return {
      ok: false,
      error: { kind: "timeout", detail: `difft exceeded ${timeoutMs}ms` },
    };
  }

  if (proc.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: "nonzero-exit",
        exitCode: proc.exitCode ?? undefined,
        detail:
          stderr.trim() ||
          (proc.signalCode
            ? `difft killed by ${proc.signalCode}`
            : `difft exited with code ${proc.exitCode}`),
      },
    };
  }

  return { ok: true, stdout };
}

export type DifftVersionProbe =
  | { ok: true; version: string }
  | { ok: false; error: DifftasticExecError };

/**
 * Successful probes are cached per binary path for the process lifetime;
 * failures are never cached, so a binary that appears mid-session (installed,
 * PATH fixed) re-enables the engine on the next load instead of staying
 * pinned off across watch reloads.
 */
const versionProbeCache = new Map<string, DifftVersionProbe>();

/** Parse `Difftastic X.Y.Z` from `difft --version`; anything else counts as missing. */
function parseDifftVersion(stdout: string): string | undefined {
  return /^Difftastic (\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1];
}

/** Probe the difft version; a failure disables the engine for this load only. */
export function probeDifftVersion(difftPath = DEFAULT_DIFFT_PATH): DifftVersionProbe {
  const cached = versionProbeCache.get(difftPath);
  if (cached) {
    return cached;
  }

  const result = spawnDifft(["--version"], { difftPath });
  let probe: DifftVersionProbe;
  if (!result.ok) {
    probe = {
      ok: false,
      error:
        // Any probe failure disables the engine; report it as the binary being unusable.
        result.error.kind === "missing-binary"
          ? result.error
          : { kind: "missing-binary", detail: result.error.detail },
    };
  } else {
    const version = parseDifftVersion(result.stdout);
    probe = version
      ? { ok: true, version }
      : {
          ok: false,
          error: { kind: "missing-binary", detail: "unrecognized difft --version output" },
        };
  }

  if (probe.ok) {
    versionProbeCache.set(difftPath, probe);
  }
  return probe;
}

/** Test hook: clear the per-process version cache. */
export function resetDifftVersionCacheForTests() {
  versionProbeCache.clear();
}

/** Run `difft --display json` over one materialized before/after pair. */
export function runDifftJson(
  beforePath: string,
  afterPath: string,
  options: DifftasticExecOptions = {},
): DifftasticExecResult {
  return spawnDifft(["--display", "json", beforePath, afterPath], options);
}
