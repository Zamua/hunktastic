import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHunkCursors } from "../../../ui/lib/hunks";
import { findHunkIndexForLine } from "../../liveComments";
import { loadAppBootstrap } from "../../loaders";
import type { CommonOptions, FileCommandInput } from "../../types";
import { resetDifftVersionCacheForTests } from "./exec";
import { createDifftasticFallbackNotice } from "./index";

/**
 * End-to-end coverage of the real two-file loader path with a stubbed difft
 * binary: the changeset comes from `loadAppBootstrap`, the JSON from the
 * committed 0.69.0 fixture, and the assertions walk the downstream consumers
 * (hunk cursors for `[`/`]` navigation, comment line anchoring).
 */

// Stub scripts are POSIX executables; Windows has no stub-backed coverage here.
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
const beforePath = join(FIXTURES_DIR, "before.js");
const afterPath = join(FIXTURES_DIR, "after.js");
const sampleJsonPath = join(FIXTURES_DIR, "sample-0.69.0.json");

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-difft-apply-"));
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

/** Real two-file CLI input over the committed fixture pair. */
function diffInput(options: CommonOptions): FileCommandInput {
  return { kind: "diff", left: beforePath, right: afterPath, options };
}

/** Real two-file CLI input over any committed `<name>-before/after.js` pair. */
function namedDiffInput(name: string, options: CommonOptions): FileCommandInput {
  return {
    kind: "diff",
    left: join(FIXTURES_DIR, `${name}-before.js`),
    right: join(FIXTURES_DIR, `${name}-after.js`),
    options,
  };
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

describe("difftastic engine through the two-file loader", () => {
  test.skipIf(isWindows)(
    "replaces hunks end to end and falls back cleanly on stub failure",
    async () => {
      // Success path: the stub emits the captured 0.69.0 payload.
      const stub = createStubDifft(`cat "${sampleJsonPath}"`);
      const bootstrap = await loadAppBootstrap(
        diffInput({ engine: "difftastic", difftPath: stub }),
      );
      expect(bootstrap.startupNotices).toBeUndefined();
      expect(bootstrap.changeset.files).toHaveLength(1);
      const file = bootstrap.changeset.files[0]!;

      // Engine field reports difftastic produced this file's metadata.
      expect(file.engine).toBe("difftastic");
      // Hunks are the difftastic-mapped shape: one merged hunk spanning the
      // modified pair run, the context run, and the trailing addition run.
      expect(file.metadata.isPartial).toBe(false);
      expect(file.metadata.hunks).toHaveLength(1);
      const hunk = file.metadata.hunks[0]!;
      expect(hunk.deletionStart).toBe(1);
      expect(hunk.deletionCount).toBe(7);
      expect(hunk.additionStart).toBe(1);
      expect(hunk.additionCount).toBe(11);
      expect(hunk.hunkContent).toEqual([
        expect.objectContaining({ type: "change", deletions: 2, additions: 2 }),
        expect.objectContaining({ type: "context", lines: 5 }),
        expect.objectContaining({ type: "change", deletions: 0, additions: 4 }),
      ]);

      // Stats are recomputed from the mapped hunks.
      expect(file.stats).toEqual({ additions: 6, deletions: 2 });

      // Novelty spans arrive index-aligned with the flat line arrays.
      expect(file.noveltySpans).toBeDefined();
      expect(file.noveltySpans?.additionLines[0]).toEqual([
        [19, 20],
        [21, 26],
      ]);
      // Empty-changes side of a modified pair: novel line, zero spans.
      expect(file.noveltySpans?.deletionLines[0]).toEqual([]);
      // Added blank line with no chunk entry: novel by position, zero spans.
      expect(file.noveltySpans?.additionLines[7]).toEqual([]);

      // Navigation invariant: every cursor indexes a real hunk in its file.
      const cursors = buildHunkCursors(bootstrap.changeset.files);
      expect(cursors.length).toBeGreaterThan(0);
      for (const cursor of cursors) {
        const target = bootstrap.changeset.files.find((entry) => entry.id === cursor.fileId);
        expect(target).toBeDefined();
        expect(cursor.hunkIndex).toBeGreaterThanOrEqual(0);
        expect(cursor.hunkIndex).toBeLessThan(target!.metadata.hunks.length);
      }

      // Comment line anchors resolve against the mapped hunk on both sides.
      expect(findHunkIndexForLine(file, "new", 9)).toBe(0);
      expect(findHunkIndexForLine(file, "old", 2)).toBe(0);
      // A line past the new file stays uncovered.
      expect(findHunkIndexForLine(file, "new", 12)).toBe(-1);

      // Fallback path: a failing stub keeps the Pierre baseline intact.
      resetDifftVersionCacheForTests();
      const failingStub = createStubDifft("exit 2");
      const fallbackBootstrap = await loadAppBootstrap(
        diffInput({ engine: "difftastic", difftPath: failingStub }),
      );
      resetDifftVersionCacheForTests();
      const pierreBootstrap = await loadAppBootstrap(diffInput({ engine: "pierre" }));
      const fallbackFile = fallbackBootstrap.changeset.files[0]!;
      const pierreFile = pierreBootstrap.changeset.files[0]!;

      expect(fallbackBootstrap.startupNotices).toEqual([createDifftasticFallbackNotice(1)]);
      // Absent engine means the Pierre baseline.
      expect(fallbackFile.engine).toBeUndefined();
      expect(fallbackFile.noveltySpans).toBeUndefined();
      expect(fallbackFile.metadata).toEqual(pierreFile.metadata);
      expect(fallbackFile.stats).toEqual(pierreFile.stats);
    },
  );

  test.skipIf(isWindows)("carries the changed-word tier through to the file", async () => {
    const stub = createStubDifft(`cat "${join(FIXTURES_DIR, "novel-comment-0.69.0.json")}"`);
    const bootstrap = await loadAppBootstrap(
      namedDiffInput("novel-comment", { engine: "difftastic", difftPath: stub }),
    );
    const file = bootstrap.changeset.files[0]!;

    expect(file.engine).toBe("difftastic");
    // The whole comment is novel; only the word that changed carries the tier,
    // which is what difft 0.69.0 draws bold plus underline for this pair.
    expect(file.noveltySpans?.deletionLines[0]).toHaveLength(23);
    expect(file.noveltySpans?.deletionWordLines?.[0]).toEqual([[57, 62]]);
    expect(file.noveltySpans?.additionWordLines?.[0]).toEqual([[57, 64]]);
  });
});
