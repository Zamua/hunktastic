import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveNotesDir } from "../paths";
import { readNotes, resolveNoteStorePath, writeNotes } from "./store";
import type { StoredNote } from "./types";

const roots: string[] = [];

function createTempRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** One state directory plus the environment that points Hunk at it. */
function createTestStateEnv() {
  const stateRoot = createTempRoot("hunkt-notes-state-");
  return { env: { XDG_STATE_HOME: stateRoot } as NodeJS.ProcessEnv, stateRoot };
}

function createTestNote(overrides: Partial<StoredNote> = {}): StoredNote {
  return {
    anchorText: "  return value;",
    createdAt: "2026-01-01T00:00:00.000Z",
    filePath: "src/base.ts",
    id: "note-1",
    line: 3,
    prefixText: "export function alpha() {\n  const value = 1;",
    side: "old",
    source: "mcp",
    suffixText: "}",
    summary: "Check this line",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("note store paths", () => {
  test("resolves the notes directory from the state home", () => {
    const xdg = { XDG_STATE_HOME: join("/tmp", "xdg-state") } as NodeJS.ProcessEnv;
    expect(resolveNotesDir(xdg)).toBe(join("/tmp", "xdg-state", "hunkt", "notes"));

    const home = { HOME: join("/tmp", "home") } as NodeJS.ProcessEnv;
    expect(resolveNotesDir(home)).toBe(join("/tmp", "home", ".local", "state", "hunkt", "notes"));
  });

  test("gives each worktree and review target its own file", () => {
    const env = { XDG_STATE_HOME: join("/tmp", "xdg-state") } as NodeJS.ProcessEnv;
    const first = resolveNoteStorePath({ reviewTarget: "diff", worktreeRoot: "/repos/a" }, env);
    const second = resolveNoteStorePath({ reviewTarget: "diff", worktreeRoot: "/repos/b" }, env);
    const show = resolveNoteStorePath(
      { reviewTarget: "show HEAD~1", worktreeRoot: "/repos/a" },
      env,
    );

    expect(first).not.toBe(second);
    expect(first).not.toBe(show);
    expect(first).toStartWith(join("/tmp", "xdg-state", "hunkt", "notes"));
  });
});

describe("note store", () => {
  test("writes notes under the state directory and reads them back", () => {
    const { env, stateRoot } = createTestStateEnv();
    const scope = { reviewTarget: "diff", worktreeRoot: "/repos/a" };
    const notes = [createTestNote(), createTestNote({ id: "note-2", line: 9 })];

    expect(writeNotes(scope, notes, env)).toBe(true);
    expect(readNotes(scope, env)).toEqual(notes);

    const path = resolveNoteStorePath(scope, env) as string;
    expect(dirname(path)).toBe(join(stateRoot, "hunkt", "notes"));
    // Key material lives in the file so a hashed name can be traced back.
    expect(JSON.parse(readFileSync(path, "utf8")).scope).toEqual(scope);
  });

  test("keeps notes from different worktrees and review targets apart", () => {
    const { env } = createTestStateEnv();
    const worktree = { reviewTarget: "diff", worktreeRoot: "/repos/a" };
    const sibling = { reviewTarget: "diff", worktreeRoot: "/repos/a-wt" };
    const show = { reviewTarget: "show HEAD~1", worktreeRoot: "/repos/a" };

    writeNotes(worktree, [createTestNote()], env);

    expect(readNotes(worktree, env)).toHaveLength(1);
    expect(readNotes(sibling, env)).toEqual([]);
    expect(readNotes(show, env)).toEqual([]);
  });

  test("never writes inside the reviewed worktree", () => {
    const { env } = createTestStateEnv();
    const worktreeRoot = createTempRoot("hunkt-notes-repo-");
    mkdirSync(join(worktreeRoot, ".git"));

    expect(writeNotes({ reviewTarget: "diff", worktreeRoot }, [createTestNote()], env)).toBe(true);

    expect(readdirSync(worktreeRoot)).toEqual([".git"]);
    expect(readdirSync(join(worktreeRoot, ".git"))).toEqual([]);
  });

  test("returns no notes when nothing has been stored", () => {
    const { env } = createTestStateEnv();

    expect(readNotes({ reviewTarget: "diff", worktreeRoot: "/repos/a" }, env)).toEqual([]);
  });

  test("returns no notes for a corrupt store", () => {
    const { env } = createTestStateEnv();
    const scope = { reviewTarget: "diff", worktreeRoot: "/repos/a" };
    const path = resolveNoteStorePath(scope, env) as string;

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ this is not json", "utf8");

    expect(readNotes(scope, env)).toEqual([]);
  });

  test("returns no notes when the store cannot be read", () => {
    const { env } = createTestStateEnv();
    const scope = { reviewTarget: "diff", worktreeRoot: "/repos/a" };
    const path = resolveNoteStorePath(scope, env) as string;

    // A directory where the file belongs makes every read fail.
    mkdirSync(path, { recursive: true });

    expect(readNotes(scope, env)).toEqual([]);
  });

  test("drops stored entries that lost their shape", () => {
    const { env } = createTestStateEnv();
    const scope = { reviewTarget: "diff", worktreeRoot: "/repos/a" };
    const path = resolveNoteStorePath(scope, env) as string;
    const note = createTestNote();

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ notes: [note, { id: "broken" }, null], scope, version: 1 }),
      "utf8",
    );

    expect(readNotes(scope, env)).toEqual([note]);
  });

  test("reports failure instead of throwing when no state directory exists", () => {
    const env = {} as NodeJS.ProcessEnv;
    const scope = { reviewTarget: "diff", worktreeRoot: "/repos/a" };

    expect(writeNotes(scope, [createTestNote()], env)).toBe(false);
    expect(readNotes(scope, env)).toEqual([]);
  });

  test("leaves no temporary files behind", () => {
    const { env, stateRoot } = createTestStateEnv();
    const scope = { reviewTarget: "diff", worktreeRoot: "/repos/a" };

    writeNotes(scope, [createTestNote()], env);
    writeNotes(scope, [], env);

    expect(readdirSync(join(stateRoot, "hunkt", "notes"))).toHaveLength(1);
    expect(readNotes(scope, env)).toEqual([]);
  });
});
