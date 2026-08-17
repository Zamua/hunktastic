/**
 * Declares the normalized changeset model every input source produces and every
 * surface consumes: one `Changeset` of ordered `DiffFile`s plus the sidecar
 * context matched onto them.
 *
 * Kept as a leaf module so loaders, the VCS contract, and watch planning can
 * share these shapes without importing `core/types`, which layers the
 * app-facing types above them.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { AgentFileContext } from "../extension-api/types";
import type { FileSourceFetcher } from "./fileSource";

/** One loaded review sidecar: the changeset summary plus every annotated file it names. */
export interface SidecarContext {
  version: number;
  summary?: string;
  files: AgentFileContext[];
}

/** Diff engine that computed a file's hunks. */
export type DiffEngineId = "pierre" | "difftastic";

/** Structural diffs are the point of this fork, so they are on unless asked otherwise. */
export const DEFAULT_DIFF_ENGINE: DiffEngineId = "difftastic";

/** One intraline novelty range: 0-based, end-exclusive column offsets into the line text. */
export type ColumnSpan = [number, number];

/**
 * Per-line intraline novelty columns, index-aligned with the flat
 * `FileDiffMetadata.additionLines` / `deletionLines` arrays. Sparse: only
 * novel lines carry entries; a novel line with no token spans carries `[]`.
 *
 * `*WordLines` carry difftastic's second novelty tier (`NovelWord`): the
 * sub-ranges of the same line's novel columns that actually differ from the
 * opposite side. Same index space and same sparseness as the arrays above, so a
 * novel line whose atom has no changed word carries `[]`. Absent altogether when
 * the producer resolved no word tier.
 */
export interface DiffLineNoveltySpans {
  additionLines: Array<ColumnSpan[] | undefined>;
  deletionLines: Array<ColumnSpan[] | undefined>;
  additionWordLines?: Array<ColumnSpan[] | undefined>;
  deletionWordLines?: Array<ColumnSpan[] | undefined>;
}

export interface DiffFile {
  id: string;
  path: string;
  previousPath?: string;
  patch: string;
  language?: string;
  stats: {
    additions: number;
    deletions: number;
  };
  metadata: FileDiffMetadata;
  /** Engine that produced `metadata`; absent means the Pierre baseline. */
  engine?: DiffEngineId;
  /** Intraline novelty columns attached when `engine` is `"difftastic"`. */
  noveltySpans?: DiffLineNoveltySpans;
  lineMoveKinds?: DiffLineMoveKinds;
  agent: AgentFileContext | null;
  isUntracked?: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
  statsTruncated?: boolean;
  // Optional capability for fetching the file's full text on either side.
  // Loaders attach this when source content is reachable; absent when not.
  sourceFetcher?: FileSourceFetcher;
}

export type DiffLineMoveKind = "moved";

export interface DiffLineMoveKinds {
  additionLines: Array<DiffLineMoveKind | undefined>;
  deletionLines: Array<DiffLineMoveKind | undefined>;
}

export interface Changeset {
  id: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: DiffFile[];
}
