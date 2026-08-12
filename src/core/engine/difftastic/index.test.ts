import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import type { FileSourceFetcher } from "../../fileSource";
import type { Changeset, DiffFile } from "../../types";
import { resetDifftVersionCacheForTests } from "./exec";
import {
  applyDifftasticEngine,
  createDifftasticFallbackNotice,
  DIFFT_MISSING_NOTICE,
} from "./index";

// Stub scripts are POSIX executables; Windows keeps the portable cases only.
const isWindows = process.platform === "win32";

const FIXTURES_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "difftastic",
);

const beforeText = readFileSync(join(FIXTURES_DIR, "before.js"), "utf8");
const afterText = readFileSync(join(FIXTURES_DIR, "after.js"), "utf8");
const sampleJsonPath = join(FIXTURES_DIR, "sample-0.69.0.json");

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-difft-engine-"));
  tempDirs.push(dir);
  return dir;
}

/** POSIX stub answering the version probe, then running `body` for diff calls. */
function createStubDifft(body: string): string {
  const path = join(createTempDir(), "difft-stub");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "Difftastic 0.69.0"',
      "  exit 0",
      "fi",
      body,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function fixtureFetcher(
  old: string | null = beforeText,
  next: string | null = afterText,
): FileSourceFetcher {
  return {
    async getFullText(side) {
      return side === "old" ? old : next;
    },
  };
}

function createFixtureFile(overrides: Partial<DiffFile> = {}): DiffFile {
  const file = createTestDiffFile({
    before: beforeText,
    after: afterText,
    id: "sample",
    path: "sample.js",
    sourceFetcher: fixtureFetcher(),
  });
  return { ...file, ...overrides };
}

function createChangeset(files: DiffFile[]): Changeset {
  return { id: "changeset:test", sourceLabel: "test", title: "test", files };
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

describe("applyDifftasticEngine", () => {
  test("missing binary leaves the changeset untouched with one startup notice", async () => {
    const file = createFixtureFile();
    const baseline = file.metadata;
    const result = await applyDifftasticEngine(createChangeset([file]), {
      difftPath: join(createTempDir(), "no-such-difft"),
    });

    expect(result).toEqual({ applied: 0, fallbacks: [], notices: [DIFFT_MISSING_NOTICE] });
    expect(file.metadata).toBe(baseline);
    expect(file.engine).toBeUndefined();
    expect(file.noveltySpans).toBeUndefined();
  });

  test.skipIf(isWindows)(
    "replaces metadata, stats, and novelty spans for an eligible file",
    async () => {
      const stub = createStubDifft(`cat "${sampleJsonPath}"`);
      const file = createFixtureFile();
      const changeset = createChangeset([file]);

      const result = await applyDifftasticEngine(changeset, { difftPath: stub });

      expect(result.applied).toBe(1);
      expect(result.fallbacks).toEqual([]);
      expect(result.notices).toEqual([]);
      expect(file.engine).toBe("difftastic");
      expect(file.metadata.isPartial).toBe(false);
      expect(file.metadata.hunks).toHaveLength(1);
      expect(file.metadata.deletionLines.join("")).toBe(beforeText);
      expect(file.metadata.additionLines.join("")).toBe(afterText);
      // File render-row totals reproduce Pierre's arithmetic over the mapped hunks.
      expect(file.metadata.splitLineCount).toBe(11);
      expect(file.metadata.unifiedLineCount).toBe(13);
      // Header counts come from the mapped hunks, not the baseline patch.
      expect(file.stats).toEqual({ additions: 6, deletions: 2 });
      expect(file.noveltySpans?.additionLines[7]).toEqual([]);
      expect(file.noveltySpans?.deletionLines[0]).toEqual([]);
    },
  );

  test.skipIf(isWindows)("skips binary, oversized, new, and deleted files silently", async () => {
    const stub = createStubDifft(`cat "${sampleJsonPath}"`);
    const files = [
      createFixtureFile({ isBinary: true }),
      createFixtureFile({ isTooLarge: true }),
      createFixtureFile({ metadata: { ...createFixtureFile().metadata, type: "new" } }),
      createFixtureFile({ metadata: { ...createFixtureFile().metadata, type: "deleted" } }),
    ];
    const baselines = files.map((file) => file.metadata);

    const result = await applyDifftasticEngine(createChangeset(files), { difftPath: stub });

    expect(result.applied).toBe(0);
    expect(result.fallbacks).toEqual([]);
    expect(result.notices).toEqual([]);
    files.forEach((file, index) => {
      expect(file.metadata).toBe(baselines[index]!);
      // Absent engine means the Pierre baseline.
      expect(file.engine).toBeUndefined();
    });
  });

  test.skipIf(isWindows)(
    "records a per-file fallback and one aggregate notice on nonzero exit",
    async () => {
      const stub = createStubDifft("exit 2");
      const file = createFixtureFile();
      const baseline = file.metadata;

      const result = await applyDifftasticEngine(createChangeset([file]), { difftPath: stub });

      expect(result.applied).toBe(0);
      expect(result.fallbacks).toEqual([
        { path: "sample.js", reason: "nonzero-exit", detail: expect.any(String) },
      ]);
      expect(result.notices).toEqual([createDifftasticFallbackNotice(1)]);
      expect(file.metadata).toBe(baseline);
      expect(file.engine).toBeUndefined();
    },
  );

  test.skipIf(isWindows)(
    "falls back per file on unparseable and schema-invalid output",
    async () => {
      for (const [body, reason] of [
        ["echo not-json", "invalid-json"],
        [`echo '{"status":123}'`, "schema-mismatch"],
      ] as const) {
        resetDifftVersionCacheForTests();
        const stub = createStubDifft(body);
        const file = createFixtureFile();

        const result = await applyDifftasticEngine(createChangeset([file]), { difftPath: stub });

        expect(result.fallbacks.map((fallback) => fallback.reason)).toEqual([reason]);
        expect(file.engine).toBeUndefined();
      }
    },
  );

  test.skipIf(isWindows)(
    "falls back per file when the payload disagrees with the bodies",
    async () => {
      const stub = createStubDifft(`cat "${sampleJsonPath}"`);
      // Bodies that do not match the captured alignment force a mapper rejection.
      const file = createFixtureFile({ sourceFetcher: fixtureFetcher("only one line\n", "x\n") });
      const baseline = file.metadata;

      const result = await applyDifftasticEngine(createChangeset([file]), { difftPath: stub });

      expect(result.fallbacks.map((fallback) => fallback.reason)).toEqual(["invalid-alignment"]);
      expect(file.metadata).toBe(baseline);
      expect(file.engine).toBeUndefined();
    },
  );

  test.skipIf(isWindows)("falls back per file when a source side is unavailable", async () => {
    const stub = createStubDifft(`cat "${sampleJsonPath}"`);
    const file = createFixtureFile({ sourceFetcher: fixtureFetcher(null, afterText) });

    const result = await applyDifftasticEngine(createChangeset([file]), { difftPath: stub });

    expect(result.fallbacks.map((fallback) => fallback.reason)).toEqual(["source-unavailable"]);
    expect(file.engine).toBeUndefined();
  });

  test.skipIf(isWindows)("keeps an unchanged-status file with empty hunks", async () => {
    const stub = createStubDifft(
      `echo '{"language":"JavaScript","path":"sample.js","status":"unchanged"}'`,
    );
    const file = createFixtureFile();

    const result = await applyDifftasticEngine(createChangeset([file]), { difftPath: stub });

    expect(result.applied).toBe(1);
    expect(file.engine).toBe("difftastic");
    expect(file.metadata.hunks).toEqual([]);
    expect(file.metadata.splitLineCount).toBe(0);
    expect(file.metadata.unifiedLineCount).toBe(0);
    expect(file.stats).toEqual({ additions: 0, deletions: 0 });
  });

  test.skipIf(isWindows)("hands the two-file flow's real paths to difft unchanged", async () => {
    const marker = join(createTempDir(), "argv");
    const stub = createStubDifft(`echo "$@" > "${marker}"\ncat "${sampleJsonPath}"`);
    const pairDir = createTempDir();
    const oldPath = join(pairDir, "before.js");
    const newPath = join(pairDir, "after.js");
    writeFileSync(oldPath, beforeText);
    writeFileSync(newPath, afterText);
    const file = createFixtureFile();

    const result = await applyDifftasticEngine(createChangeset([file]), {
      difftPath: stub,
      directPaths: { old: oldPath, new: newPath },
    });

    expect(result.applied).toBe(1);
    expect(readFileSync(marker, "utf8").trim()).toBe(`--display json ${oldPath} ${newPath}`);
  });
});
