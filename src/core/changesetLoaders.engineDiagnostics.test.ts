import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../app/cli";
import { resetDifftVersionCacheForTests } from "./engine/difftastic/exec";
import { loadAppBootstrap } from "./changesetLoaders";
import type { CliInput } from "./types";

// Stub scripts are POSIX executables; Windows keeps no cases here.
const isWindows = platform() === "win32";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-loader-difft-diag-")));
  tempDirs.push(dir);
  return dir;
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

/** POSIX stub answering the version probe, then failing every diff invocation. */
function createFailingStubDifft(dir: string) {
  const stubPath = join(dir, "difft-stub");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "Difftastic 0.69.0"',
      "  exit 0",
      "fi",
      'echo "boom" >&2',
      "exit 2",
      "",
    ].join("\n"),
  );
  chmodSync(stubPath, 0o755);
  return stubPath;
}

describe("difftastic engine fallback diagnostics", () => {
  test.skipIf(isWindows)("emits one diagnostic line per per-file fallback", async () => {
    const dir = createTempDir();
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "const alpha = 1;\n");
    writeFileSync(right, "const alpha = 2;\n");

    const messages: string[] = [];
    const bootstrap = await loadAppBootstrap(
      {
        kind: "diff",
        left,
        right,
        options: { engine: "difftastic", difftPath: createFailingStubDifft(dir) },
      },
      { onEngineDiagnostic: (message) => messages.push(message) },
    );

    expect(bootstrap.startupNotices?.map((notice) => notice.key)).toEqual(["difftastic:fallback"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("after.ts");
    expect(messages[0]).toContain("nonzero-exit");
    expect(messages[0]).toContain("boom");
  });

  test("stays silent when the whole engine is unavailable (no per-file fallbacks)", async () => {
    resetDifftVersionCacheForTests();
    const dir = createTempDir();
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "const alpha = 1;\n");
    writeFileSync(right, "const alpha = 2;\n");

    const messages: string[] = [];
    const bootstrap = await loadAppBootstrap(
      {
        kind: "diff",
        left,
        right,
        options: { engine: "difftastic", difftPath: join(dir, "no-such-difft") },
      },
      { onEngineDiagnostic: (message) => messages.push(message) },
    );

    expect(bootstrap.startupNotices?.map((notice) => notice.key)).toEqual([
      "difftastic:binary-missing",
    ]);
    expect(messages).toEqual([]);
  });
});

describe("--engine flag reaches the engine", () => {
  test.skipIf(isWindows)("a parsed --engine difftastic runs difftastic in the loader", async () => {
    const dir = createTempDir();
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "const alpha = 1;\n");
    writeFileSync(right, "const alpha = 2;\n");

    const parsed = await parseCli(["bun", "hunkt", "diff", left, right, "--engine", "difftastic"]);
    expect(parsed).toMatchObject({ kind: "diff", options: { engine: "difftastic" } });

    // difftPath is config-resolved, not a CLI flag; pin it to the stub so the
    // engine invocation is observable without the real binary.
    const input = parsed as CliInput;
    const stubbed: CliInput = {
      ...input,
      options: { ...input.options, difftPath: createFailingStubDifft(dir) },
    };

    const withFlag = await loadAppBootstrap(stubbed, { onEngineDiagnostic: () => {} });
    expect(withFlag.startupNotices?.map((notice) => notice.key)).toEqual(["difftastic:fallback"]);

    // Without the flag the loader must not touch the engine at all.
    const bare = (await parseCli(["bun", "hunkt", "diff", left, right])) as CliInput;
    const withoutFlag = await loadAppBootstrap(bare, { onEngineDiagnostic: () => {} });
    expect(withoutFlag.startupNotices).toBeUndefined();
  });
});
