import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "src/main.tsx");
const difftasticFixturesDir = join(repoRoot, "test", "fixtures", "difftastic");
// Spawned hunk processes must assert built-in defaults, not the developer's ambient user config.
const testConfigHome = createTestConfigHome();

afterAll(cleanupTestConfigHomes);

// PTY-driven cases are Unix-only, like all of test/pty. The fallback case needs
// no difft binary and must never be gated on one; only the live-engine case is.
const isWindows = process.platform === "win32";
const ptyTest = isWindows ? test.skip : test;
const difftPtyTest = !isWindows && Bun.which("difft") ? test : test.skip;

/** PTY startup, difft spawns, and daemon registration need CI headroom. */
setDefaultTimeout(30_000);

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Launch the real CLI in a PTY so the full-screen review renders like a user terminal. */
async function launchHunk(options: {
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}) {
  const { launchTerminal } = await import("tuistory");

  return launchTerminal({
    command: process.execPath,
    args: ["run", sourceEntrypoint, "--", ...options.args],
    cwd: options.cwd ?? repoRoot,
    cols: 140,
    rows: 24,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: testConfigHome,
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
      ...options.env,
    },
  });
}

async function waitUntil<T>(
  label: string,
  poll: () => T | null | Promise<T | null>,
  timeoutMs = 15_000,
  intervalMs = 150,
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await poll();
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await Bun.sleep(intervalMs);
  }
}

async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  if (!port) {
    throw new Error("Failed to reserve a loopback port for the session daemon test.");
  }

  return port;
}

function runSessionCli(args: string[], port: number) {
  const proc = Bun.spawnSync(["bun", "run", sourceEntrypoint, "session", ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: testConfigHome,
      HUNK_MCP_PORT: String(port),
    },
  });

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

interface SessionListJson {
  sessions: Array<{ sessionId: string }>;
}

interface SessionReviewJson {
  review: {
    engine: string;
    files: Array<{ path: string; hunkCount: number; engine: string }>;
  };
}

describe("difftastic engine CLI contracts", () => {
  ptyTest(
    "an unavailable difft binary surfaces the fallback notice and still renders via pierre",
    async () => {
      const dir = createTempDir("hunk-difft-cli-fallback-");
      const before = join(dir, "before.ts");
      const after = join(dir, "after.ts");
      writeFileSync(before, "export const answer = 41;\n");
      writeFileSync(after, "export const answer = 42;\n");

      const session = await launchHunk({
        args: ["diff", before, after, "--engine", "difftastic"],
        env: { HUNK_DIFFT_PATH: join(dir, "no-such-difft") },
      });

      try {
        // The startup notice queue shows each notice for a bounded window; catch it first.
        await session.waitForText(
          /difftastic engine unavailable \(difft not found\); using pierre/,
          {
            timeout: 20_000,
          },
        );

        // The changeset still renders through the Pierre fallback.
        const snapshot = await session.waitForText(/export const answer = 42;/, {
          timeout: 15_000,
        });
        expect(snapshot).toContain("export const answer = 41;");
        expect(snapshot).toContain("@@ -1,1 +1,1 @@");
      } finally {
        session.close();
      }
    },
  );

  difftPtyTest(
    "a live session renders structural hunks and reports engine difftastic over review --json",
    async () => {
      const port = await reserveLoopbackPort();
      const session = await launchHunk({
        args: [
          "diff",
          join(difftasticFixturesDir, "before.js"),
          join(difftasticFixturesDir, "after.js"),
          "--engine",
          "difftastic",
        ],
        env: { HUNK_MCP_DISABLE: undefined, HUNK_MCP_PORT: String(port) },
      });

      let daemonPid: number | null = null;
      try {
        // The structural hunk renders: difftastic alignment keeps the whole
        // changeset in one hunk that includes the added trailing function.
        const snapshot = await session.waitForText(/function sub\(a, b\)/, { timeout: 20_000 });
        expect(snapshot).toContain("@@");

        const health = await waitUntil("session daemon health endpoint", async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (!response.ok) {
              return null;
            }
            return (await response.json()) as { ok: boolean; pid: number };
          } catch {
            return null;
          }
        });
        daemonPid = health.pid;

        const sessionId = await waitUntil("registered Hunk session", () => {
          const listed = runSessionCli(["list", "--json"], port);
          if (listed.exitCode !== 0) {
            return null;
          }
          const parsed = JSON.parse(listed.stdout) as SessionListJson;
          return parsed.sessions[0]?.sessionId ?? null;
        });

        const review = await waitUntil("session review export", () => {
          const result = runSessionCli(["review", sessionId, "--json"], port);
          if (result.exitCode !== 0) {
            return null;
          }
          return (JSON.parse(result.stdout) as SessionReviewJson).review;
        });

        expect(review.engine).toBe("difftastic");
        expect(review.files).toHaveLength(1);
        expect(review.files[0]?.engine).toBe("difftastic");
        expect(review.files[0]?.hunkCount).toBeGreaterThan(0);
      } finally {
        session.close();
        if (daemonPid) {
          try {
            process.kill(daemonPid, "SIGTERM");
          } catch {
            // The daemon exited on its own; nothing to clean up.
          }
        }
      }
    },
  );
});
