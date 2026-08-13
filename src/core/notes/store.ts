import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNotesDir } from "../paths";
import type { StoredNote } from "./types";

/** Format version stamped on every store file. */
const NOTE_STORE_VERSION = 1;

/**
 * What one persisted note file belongs to.
 *
 * The worktree root is the identity, not the repository: two worktrees of one
 * repository are reviews of two different trees, and `--show-toplevel` differs
 * per worktree while `--git-common-dir` is shared. The review target keeps
 * notes taken over an old commit from reappearing over uncommitted work.
 */
export interface NoteScope {
  /** Absolute worktree root, canonicalized by the caller. */
  worktreeRoot: string;
  /** What is under review, e.g. `diff` for the working tree or a revision. */
  reviewTarget: string;
}

/** On-disk shape of one scope's notes. */
interface NoteStoreFile {
  version: number;
  /** Key material, written so a human can tell what a hashed file name belongs to. */
  scope: NoteScope;
  notes: StoredNote[];
}

/**
 * Hash the scope key into a file name stem.
 *
 * 32 hex characters keep the directory listing readable while leaving
 * collisions out of reach for a machine-local store.
 */
export function noteScopeHash(scope: NoteScope) {
  // A NUL separator cannot occur in a path, so no two scopes can share a key.
  const key = `${scope.worktreeRoot}\u0000${scope.reviewTarget}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Resolve the file one scope's notes persist in.
 *
 * The path is derived from the state directory alone; the worktree only ever
 * feeds the hash, so no note can be written inside a repository.
 */
export function resolveNoteStorePath(scope: NoteScope, env: NodeJS.ProcessEnv = process.env) {
  const notesDir = resolveNotesDir(env);
  return notesDir ? join(notesDir, `${noteScopeHash(scope)}.json`) : undefined;
}

/** Narrow one parsed entry to a note that can still be placed or displayed. */
function isStoredNote(value: unknown): value is StoredNote {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const note = value as Partial<StoredNote>;
  return (
    typeof note.id === "string" &&
    typeof note.filePath === "string" &&
    (note.side === "old" || note.side === "new") &&
    typeof note.line === "number" &&
    Number.isFinite(note.line) &&
    typeof note.summary === "string" &&
    typeof note.anchorText === "string"
  );
}

/**
 * Read one scope's notes, treating every damaged store as an empty one.
 *
 * A store is a convenience, so no failure to read it may fail a review: a
 * missing file, an unreadable file, unparseable bytes, and individual entries
 * that lost their shape all degrade to fewer notes rather than an exception.
 */
export function readNotes(scope: NoteScope, env: NodeJS.ProcessEnv = process.env): StoredNote[] {
  const path = resolveNoteStorePath(scope, env);
  if (!path) {
    return [];
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }

  const notes = (parsed as Partial<NoteStoreFile>).notes;
  return Array.isArray(notes) ? notes.filter(isStoredNote) : [];
}

/** Delete one path without letting cleanup failures mask the original outcome. */
function removeQuietly(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing left to do: the temp file is already unreachable to readers.
  }
}

/**
 * Write one scope's notes, replacing whatever the file held.
 *
 * The payload is staged in a sibling temp file and renamed into place, so a
 * crash mid-write leaves the previous notes intact instead of a truncated file.
 * The temp file is a sibling to keep the rename within one filesystem, which is
 * what makes it atomic. A rename that cannot be completed gives up and reports
 * failure rather than falling back to an in-place write, because a non-atomic
 * write is the one outcome this function exists to prevent.
 *
 * Returns whether the notes reached disk.
 */
export function writeNotes(
  scope: NoteScope,
  notes: StoredNote[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = resolveNoteStorePath(scope, env);
  if (!path) {
    return false;
  }

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  try {
    // Serializing inside the guard keeps every way this can fail on the same
    // path: the caller defers the write off its own stack, so a throw here
    // would surface as an unhandled rejection rather than a failed write.
    const payload: NoteStoreFile = { version: NOTE_STORE_VERSION, scope, notes };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    removeQuietly(tempPath);
    return false;
  }

  try {
    renameSync(tempPath, path);
    return true;
  } catch {
    // Windows refuses a rename over a file another process still holds open.
    try {
      rmSync(path, { force: true });
      renameSync(tempPath, path);
      return true;
    } catch {
      removeQuietly(tempPath);
      return false;
    }
  }
}
