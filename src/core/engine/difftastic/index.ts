import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import { countDiffStats } from "../../diffFile";
import type { StartupNotice } from "../../startupNotice";
import {
  DEFAULT_NOVELTY_STYLE,
  type Changeset,
  type DiffFile,
  type NoveltyStyle,
} from "../../types";
import { probeDifftVersion, runDifftJson, type DifftasticExecOptions } from "./exec";
import { isDifftasticMapFallback, mapDifftasticFile } from "./map";
import { createMaterializeRoot, materializeFilePair, type MaterializeRoot } from "./materialize";
import { parseDifftasticJson } from "./schema";

/**
 * Overlays difftastic-produced hunks onto an already-parsed changeset. Every
 * file keeps its Pierre baseline unless the whole ladder (materialize, spawn,
 * schema, map) succeeds; any failure records a per-file fallback and leaves
 * the metadata untouched.
 */

export interface ApplyDifftasticEngineOptions extends DifftasticExecOptions {
  /**
   * Real on-disk paths for the two-file flow. Only honored for a
   * single-file changeset, where the pair is unambiguous.
   */
  directPaths?: { old: string; new: string };
  /** How novel tokens are marked; recorded on each mapped file for the renderer. */
  novelty?: NoveltyStyle;
}

export interface DifftasticFileFallback {
  path: string;
  reason: string;
  detail: string;
}

export interface DifftasticEngineResult {
  /** Count of files whose metadata difftastic replaced. */
  applied: number;
  /** Per-file fallback details, for diagnostics; the UI sees one aggregate notice. */
  fallbacks: DifftasticFileFallback[];
  notices: StartupNotice[];
}

/** Shown once when the binary is unusable and the whole changeset stays on Pierre. */
export const DIFFT_MISSING_NOTICE: StartupNotice = {
  key: "difftastic:binary-missing",
  message: "difftastic engine unavailable (difft not found); using pierre",
};

/** Aggregate per-file fallbacks into the one notice the UI shows. */
export function createDifftasticFallbackNotice(count: number): StartupNotice {
  return {
    key: "difftastic:fallback",
    message: `difftastic fell back to pierre for ${count} file(s)`,
  };
}

/** Return whether difft should run for this file at all; skips are silent, not fallbacks. */
function isEligible(file: DiffFile): boolean {
  if (file.isBinary || file.isTooLarge) {
    return false;
  }

  // A pure creation or deletion has no structural alignment to compute;
  // Pierre's all-addition/all-deletion hunk is already correct.
  return file.metadata.type !== "new" && file.metadata.type !== "deleted";
}

/** Reproduce Pierre's file-level render-row totals from the mapped hunks. */
function computeFileLineCounts(
  hunks: Hunk[],
  additionLineCount: number,
  deletionLineCount: number,
) {
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  for (const hunk of hunks) {
    splitLineCount += hunk.collapsedBefore + hunk.splitLineCount;
    unifiedLineCount += hunk.collapsedBefore + hunk.unifiedLineCount;
  }

  // Trailing collapsed rows after the last hunk, matching parsePatchFiles.
  if (hunks.length > 0 && additionLineCount > 0 && deletionLineCount > 0) {
    const lastHunk = hunks[hunks.length - 1]!;
    const lastHunkEnd = lastHunk.additionStart + lastHunk.additionCount - 1;
    const collapsedAfter = Math.max(additionLineCount - lastHunkEnd, 0);
    splitLineCount += collapsedAfter;
    unifiedLineCount += collapsedAfter;
  }

  return { splitLineCount, unifiedLineCount };
}

/** Run one file through materialize -> difft -> schema -> map, or name the failed rung. */
async function overlayFile(
  file: DiffFile,
  index: number,
  tmpRoot: MaterializeRoot,
  options: ApplyDifftasticEngineOptions,
  useDirectPaths: boolean,
): Promise<DifftasticFileFallback | undefined> {
  const materialized = await materializeFilePair(file, {
    directPaths: useDirectPaths ? options.directPaths : undefined,
    tmpRoot,
    pairIndex: index,
  });
  if (!materialized.ok) {
    return { path: file.path, reason: materialized.reason, detail: materialized.detail };
  }

  const { pair } = materialized;
  const executed = runDifftJson(pair.oldPath, pair.newPath, {
    difftPath: options.difftPath,
    timeoutMs: options.timeoutMs,
  });
  if (!executed.ok) {
    return { path: file.path, reason: executed.error.kind, detail: executed.error.detail };
  }

  const parsed = parseDifftasticJson(executed.stdout);
  if (!parsed.ok) {
    return { path: file.path, reason: parsed.error.kind, detail: parsed.error.message };
  }

  const mapped = mapDifftasticFile(parsed.file, pair.oldText, pair.newText, {
    changeType: file.metadata.type,
  });
  if (isDifftasticMapFallback(mapped)) {
    return { path: file.path, reason: mapped.fallback, detail: mapped.detail };
  }

  const { splitLineCount, unifiedLineCount } = computeFileLineCounts(
    mapped.hunks,
    mapped.additionLines.length,
    mapped.deletionLines.length,
  );
  const metadata: FileDiffMetadata = {
    ...file.metadata,
    type: mapped.changeType,
    hunks: mapped.hunks,
    splitLineCount,
    unifiedLineCount,
    // Full-contents convention: highlight plans and collapsed-gap expansion
    // read real file lines instead of patch-shaped partial arrays.
    isPartial: false,
    additionLines: mapped.additionLines,
    deletionLines: mapped.deletionLines,
    cacheKey: file.metadata.cacheKey ? `${file.metadata.cacheKey}:difftastic` : undefined,
  };
  file.metadata = metadata;
  file.engine = "difftastic";
  file.noveltySpans = mapped.noveltySpans;
  file.noveltyStyle = options.novelty ?? DEFAULT_NOVELTY_STYLE;
  // Header counts must match the rendered rows, not the baseline patch.
  file.stats = countDiffStats(metadata);
  return undefined;
}

/** Apply the difftastic engine to every eligible file, mutating the changeset in place. */
export async function applyDifftasticEngine(
  changeset: Changeset,
  options: ApplyDifftasticEngineOptions = {},
): Promise<DifftasticEngineResult> {
  const probe = probeDifftVersion(options.difftPath);
  if (!probe.ok) {
    return { applied: 0, fallbacks: [], notices: [DIFFT_MISSING_NOTICE] };
  }

  const fallbacks: DifftasticFileFallback[] = [];
  let applied = 0;
  // Direct paths name one concrete pair, so they only apply unambiguously.
  const useDirectPaths = Boolean(options.directPaths) && changeset.files.length === 1;
  const tmpRoot = createMaterializeRoot();
  try {
    // Absent `engine` means the Pierre baseline; only a successful overlay
    // (inside overlayFile) sets `engine: "difftastic"`.
    for (const [index, file] of changeset.files.entries()) {
      if (!isEligible(file)) {
        continue;
      }

      const fallback = await overlayFile(file, index, tmpRoot, options, useDirectPaths);
      if (fallback) {
        fallbacks.push(fallback);
      } else {
        applied += 1;
      }
    }
  } finally {
    tmpRoot.cleanup();
  }

  return {
    applied,
    fallbacks,
    notices: fallbacks.length > 0 ? [createDifftasticFallbackNotice(fallbacks.length)] : [],
  };
}
