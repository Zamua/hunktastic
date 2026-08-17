import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SourceTextTooLargeError } from "../../fileSource";
import type { DiffFile } from "../../types";

/**
 * Obtains both file bodies for one difft invocation. The two-file flow hands
 * difft the real on-disk paths; git-backed files fetch both sides through the
 * file's `sourceFetcher` and write them under a caller-owned temp root,
 * preserving each side's basename so difft's extension-based language
 * detection works.
 */

export interface MaterializedPair {
  oldPath: string;
  newPath: string;
  oldText: string;
  newText: string;
}

export type MaterializeFailureReason = "source-unavailable" | "source-too-large";

export type MaterializeResult =
  | { ok: true; pair: MaterializedPair }
  | { ok: false; reason: MaterializeFailureReason; detail: string };

export interface MaterializeRoot {
  path: string;
  cleanup(): void;
}

/** Create the per-run temp tree difft inputs are written under; delete it in `finally`. */
export function createMaterializeRoot(): MaterializeRoot {
  const path = mkdtempSync(join(tmpdir(), `hunk-difft-${process.pid}-`));
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export interface MaterializeFilePairOptions {
  /** Real on-disk paths for the two-file flow; skips temp writes entirely. */
  directPaths?: { old: string; new: string };
  /** Temp tree owned by the caller; required unless `directPaths` is set. */
  tmpRoot?: MaterializeRoot;
  /** Unique per-file index inside `tmpRoot`. */
  pairIndex: number;
}

/** Read one side's full text, mapping fetcher failure modes onto materialize failures. */
async function readSide(
  file: DiffFile,
  side: "old" | "new",
): Promise<{ ok: true; text: string } | { ok: false; result: MaterializeResult }> {
  if (!file.sourceFetcher) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "source-unavailable",
        detail: `${file.path}: no source fetcher`,
      },
    };
  }

  let text: string | null;
  try {
    text = await file.sourceFetcher.getFullText(side);
  } catch (error) {
    if (error instanceof SourceTextTooLargeError) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "source-too-large",
          detail: `${file.path}: ${side} side exceeds ${error.maxBytes} bytes`,
        },
      };
    }

    return {
      ok: false,
      result: {
        ok: false,
        reason: "source-unavailable",
        detail: `${file.path}: ${side} side fetch failed`,
      },
    };
  }

  if (text === null) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "source-unavailable",
        detail: `${file.path}: ${side} side unreadable`,
      },
    };
  }

  return { ok: true, text };
}

/** Materialize one file's before/after pair as concrete paths difft can read. */
export async function materializeFilePair(
  file: DiffFile,
  { directPaths, tmpRoot, pairIndex }: MaterializeFilePairOptions,
): Promise<MaterializeResult> {
  const oldSide = await readSide(file, "old");
  if (!oldSide.ok) {
    return oldSide.result;
  }

  const newSide = await readSide(file, "new");
  if (!newSide.ok) {
    return newSide.result;
  }

  if (directPaths) {
    return {
      ok: true,
      pair: {
        oldPath: directPaths.old,
        newPath: directPaths.new,
        oldText: oldSide.text,
        newText: newSide.text,
      },
    };
  }

  if (!tmpRoot) {
    return {
      ok: false,
      reason: "source-unavailable",
      detail: `${file.path}: no temp root for materialization`,
    };
  }

  const pairDir = join(tmpRoot.path, String(pairIndex));
  const oldDir = join(pairDir, "old");
  const newDir = join(pairDir, "new");
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const oldPath = join(oldDir, basename(file.previousPath ?? file.path));
  const newPath = join(newDir, basename(file.path));
  writeFileSync(oldPath, oldSide.text);
  writeFileSync(newPath, newSide.text);

  return {
    ok: true,
    pair: { oldPath, newPath, oldText: oldSide.text, newText: newSide.text },
  };
}
