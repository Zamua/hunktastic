import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDifftVersion, resetDifftVersionCacheForTests, runDifftJson } from "./exec";

// Stub scripts are POSIX executables; Windows keeps the portable cases only.
const isWindows = process.platform === "win32";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-difft-exec-"));
  tempDirs.push(dir);
  return dir;
}

/** Write one POSIX stub standing in for the difft binary. */
function createStubDifft(body: string): string {
  const path = join(createTempDir(), "difft-stub");
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  resetDifftVersionCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("difftastic exec", () => {
  test("translates a missing binary into a typed missing-binary error", () => {
    const missing = join(createTempDir(), "no-such-difft");

    const probe = probeDifftVersion(missing);
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.error.kind).toBe("missing-binary");
    }

    const run = runDifftJson("a", "b", { difftPath: missing });
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.kind).toBe("missing-binary");
    }
  });

  test("treats unparseable version output as a missing binary", () => {
    // The Bun executable answers --version with its own version string.
    const probe = probeDifftVersion(process.execPath);
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.error.kind).toBe("missing-binary");
      expect(probe.error.detail).toContain("unrecognized");
    }
  });

  test.skipIf(isWindows)("retries a failed probe once the binary becomes usable", () => {
    const path = join(createTempDir(), "difft-stub");

    const failed = probeDifftVersion(path);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.kind).toBe("missing-binary");
    }

    // The binary appears at the same path; no cache reset in between.
    writeFileSync(path, `#!/bin/sh\necho "Difftastic 0.69.0"\n`);
    chmodSync(path, 0o755);

    const retried = probeDifftVersion(path);
    expect(retried).toEqual({ ok: true, version: "0.69.0" });
  });

  test.skipIf(isWindows)("parses and caches the version probe per binary path", () => {
    const marker = join(createTempDir(), "invocations");
    const stub = createStubDifft(`echo run >> "${marker}"\necho "Difftastic 0.69.0"\n`);

    const first = probeDifftVersion(stub);
    const second = probeDifftVersion(stub);

    expect(first).toEqual({ ok: true, version: "0.69.0" });
    expect(second).toBe(first);
    expect(readFileSync(marker, "utf8")).toBe("run\n");
  });

  test.skipIf(isWindows)("returns stdout for an accepted exit", () => {
    const stub = createStubDifft(`echo '{"status":"unchanged"}'\n`);

    const result = runDifftJson("a", "b", { difftPath: stub });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toContain('"unchanged"');
    }
  });

  test.skipIf(isWindows)("sets DFT_UNSTABLE on every invocation", () => {
    const stub = createStubDifft(`printf '%s' "$DFT_UNSTABLE"\n`);

    const result = runDifftJson("a", "b", { difftPath: stub });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toBe("yes");
    }
  });

  test.skipIf(isWindows)("reports a nonzero exit with stderr detail", () => {
    const stub = createStubDifft(`echo "boom" >&2\nexit 2\n`);

    const result = runDifftJson("a", "b", { difftPath: stub });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("nonzero-exit");
      expect(result.error.exitCode).toBe(2);
      expect(result.error.detail).toContain("boom");
    }
  });

  test.skipIf(isWindows)("times out a hung invocation", () => {
    const stub = createStubDifft("sleep 5\n");

    const result = runDifftJson("a", "b", { difftPath: stub, timeoutMs: 250 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
    }
  });
});
