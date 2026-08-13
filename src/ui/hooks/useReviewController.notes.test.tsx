import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledVcsCatalog } from "../../app/vcsCatalog";
import { loadAppBootstrap } from "../../core/loaders";
import { captureReviewNoteAnchor } from "../../core/notes/session";
import { readNotes, writeNotes, type NoteScope } from "../../core/notes/store";
import type { StoredNote } from "../../core/notes/types";
import type { DiffFile } from "../../core/types";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { useReviewController, type ReviewController } from "./useReviewController";

const BASE_LINES = Array.from(
  { length: 30 },
  (_, index) => `const line${index + 1} = ${index + 1};`,
);

const tempDirs: string[] = [];
let previousStateHome: string | undefined;

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Point the note store at a temp state directory for the duration of one test. */
function useTempNoteStore() {
  previousStateHome = process.env.XDG_STATE_HOME;
  const stateDir = createTempDir("hunk-notes-state-");
  process.env.XDG_STATE_HOME = stateDir;
  return stateDir;
}

afterEach(() => {
  if (previousStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = previousStateHome;
  }
  previousStateHome = undefined;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Build the shared 30-line fixture with one line replaced. */
function fixtureFile(changedLine: number, value: string, path = "alpha.ts"): DiffFile {
  const after = [...BASE_LINES];
  after[changedLine - 1] = value;
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...BASE_LINES),
    context: 3,
    id: path,
    path,
  });
}

function storedNoteFor(
  file: DiffFile,
  {
    id,
    line,
    source,
    summary = "Persisted note",
  }: { id: string; line: number; source: string; summary?: string },
): StoredNote {
  return {
    id,
    filePath: file.path,
    side: "new",
    line,
    summary,
    source,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...captureReviewNoteAnchor(file, "new", line),
  };
}

/** One review the harness can be pointed at, the way a reload swaps the bootstrap. */
interface HarnessReview {
  files: DiffFile[];
  noteScope?: NoteScope;
}

function NotesHarness({
  initialReview,
  onController,
  onReloadReady,
}: {
  initialReview: HarnessReview;
  onController: (controller: ReviewController) => void;
  onReloadReady: (reload: (review: HarnessReview) => void) => void;
}) {
  const [review, setReview] = useState(initialReview);
  const controller = useReviewController(review);

  useEffect(() => {
    onReloadReady(setReview);
  }, [onReloadReady]);

  useEffect(() => {
    onController(controller);
  }, [controller, onController]);

  return null;
}

async function renderNotesController(files: DiffFile[], noteScope?: NoteScope) {
  const controllerRef: { current: ReviewController | null } = { current: null };
  const reloadRef: { current: ((review: HarnessReview) => void) | null } = { current: null };
  const setup = await testRender(
    <NotesHarness
      initialReview={{ files, noteScope }}
      onController={(controller) => {
        controllerRef.current = controller;
      }}
      onReloadReady={(reload) => {
        reloadRef.current = reload;
      }}
    />,
    { width: 80, height: 4 },
  );

  /** Let effects, deferred state, and the store writer's deferred flush settle. */
  const settle = async () => {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(5);
      await setup.renderOnce();
    });
  };

  const destroy = async () => {
    await act(async () => {
      setup.renderer.destroy();
    });
  };

  /** Point the mounted controller at a freshly loaded review, as a soft reload does. */
  const reload = async (review: HarnessReview) => {
    await act(async () => {
      expectValue(reloadRef.current)(review);
    });
    await settle();
  };

  await settle();
  return { controllerRef, destroy, reload, settle };
}

/** Assert one callback-populated handle exists before using it. */
function expectValue<T>(value: T): NonNullable<T> {
  expect(value).toBeDefined();
  return value as NonNullable<T>;
}

describe("useReviewController note persistence", () => {
  test("places stored notes back inline on the row they were written against", async () => {
    useTempNoteStore();
    const file = fixtureFile(10, "const line10 = 100;");
    const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };
    writeNotes(scope, [
      storedNoteFor(file, { id: "user:1", line: 10, source: "user" }),
      storedNoteFor(file, { id: "mcp:1", line: 12, source: "mcp" }),
    ]);

    const { controllerRef, destroy } = await renderNotesController([file], scope);

    try {
      const controller = expectValue(controllerRef.current);
      expect(controller.userNotesByFileId["alpha.ts"]).toMatchObject([
        { id: "user:1", line: 10, hunkIndex: 0, side: "new", restored: { state: "anchored" } },
      ]);
      expect(controller.liveCommentsByFileId["alpha.ts"]).toMatchObject([
        { id: "mcp:1", line: 12, hunkIndex: 0, side: "new", restored: { state: "anchored" } },
      ]);
      expect(controller.restoredNotes.map((entry) => entry.state)).toEqual([
        "anchored",
        "anchored",
      ]);
    } finally {
      await destroy();
    }
  });

  test("keeps a note whose line was edited away out of the inline stream but not out of the review", async () => {
    useTempNoteStore();
    const authored = fixtureFile(10, "const line10 = 100;");
    const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };
    writeNotes(scope, [storedNoteFor(authored, { id: "user:1", line: 10, source: "user" })]);

    const { controllerRef, destroy } = await renderNotesController(
      [fixtureFile(10, "const line10 = 999;")],
      scope,
    );

    try {
      const controller = expectValue(controllerRef.current);
      expect(controller.userNotesByFileId).toEqual({});
      expect(controller.liveCommentsByFileId).toEqual({});
      expect(controller.restoredNotes).toMatchObject([
        { state: "unanchored", note: { id: "user:1", anchorText: "const line10 = 100;" } },
      ]);
    } finally {
      await destroy();
    }
  });

  test("a reload that takes a note's line away also takes its inline copy away", async () => {
    useTempNoteStore();
    const authored = fixtureFile(10, "const line10 = 100;");
    const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };
    writeNotes(scope, [storedNoteFor(authored, { id: "mcp:1", line: 10, source: "mcp" })]);

    const { controllerRef, destroy, reload } = await renderNotesController([authored], scope);

    try {
      expect(expectValue(controllerRef.current).liveCommentsByFileId["alpha.ts"]).toHaveLength(1);

      await reload({
        files: [fixtureFile(10, "const line10 = 999;")],
        noteScope: { ...scope },
      });

      const controller = expectValue(controllerRef.current);
      expect(controller.liveCommentsByFileId["alpha.ts"] ?? []).toEqual([]);
      expect(controller.restoredNotes).toMatchObject([
        { state: "unanchored", note: { id: "mcp:1" } },
      ]);
    } finally {
      await destroy();
    }
  });

  test("notes written under one worktree never surface under another", async () => {
    useTempNoteStore();
    const file = fixtureFile(10, "const line10 = 100;");
    writeNotes({ worktreeRoot: "/worktrees/one", reviewTarget: "diff" }, [
      storedNoteFor(file, { id: "user:1", line: 10, source: "user" }),
    ]);

    const { controllerRef, destroy } = await renderNotesController([file], {
      worktreeRoot: "/worktrees/two",
      reviewTarget: "diff",
    });

    try {
      expect(expectValue(controllerRef.current).restoredNotes).toEqual([]);
      expect(expectValue(controllerRef.current).userNotesByFileId).toEqual({});
    } finally {
      await destroy();
    }
  });

  test("a revision review does not pick up working-tree notes", async () => {
    useTempNoteStore();
    const file = fixtureFile(10, "const line10 = 100;");
    writeNotes({ worktreeRoot: "/repo", reviewTarget: "diff" }, [
      storedNoteFor(file, { id: "user:1", line: 10, source: "user" }),
    ]);

    const { controllerRef, destroy } = await renderNotesController([file], {
      worktreeRoot: "/repo",
      reviewTarget: "show:HEAD~1",
    });

    try {
      expect(expectValue(controllerRef.current).restoredNotes).toEqual([]);
    } finally {
      await destroy();
    }
  });

  test("a two-file review writes nothing at all", async () => {
    const stateDir = useTempNoteStore();
    const file = fixtureFile(10, "const line10 = 100;");

    const { controllerRef, destroy, settle } = await renderNotesController([file], undefined);

    try {
      await act(async () => {
        expectValue(controllerRef.current).addLiveComment(
          { filePath: "alpha.ts", hunkIndex: 0, summary: "No home for this" },
          "mcp:1",
        );
      });
      await settle();

      expect(expectValue(controllerRef.current).liveCommentsByFileId["alpha.ts"]).toHaveLength(1);
      expect(existsSync(join(stateDir, "hunkt", "notes"))).toBe(false);
    } finally {
      await destroy();
    }
  });

  test("an added note is persisted and comes back on the next review of the same scope", async () => {
    useTempNoteStore();
    const file = fixtureFile(10, "const line10 = 100;");
    const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };

    const first = await renderNotesController([file], scope);
    try {
      await act(async () => {
        expectValue(first.controllerRef.current).addLiveComment(
          { filePath: "alpha.ts", hunkIndex: 0, summary: "Agent found this" },
          "mcp:1",
        );
      });
      await first.settle();

      expect(readNotes(scope)).toMatchObject([
        {
          id: "mcp:1",
          filePath: "alpha.ts",
          side: "new",
          line: 10,
          summary: "Agent found this",
          source: "mcp",
          anchorText: "const line10 = 100;",
          prefixText: "const line7 = 7;\nconst line8 = 8;\nconst line9 = 9;",
          suffixText: "const line11 = 11;\nconst line12 = 12;\nconst line13 = 13;",
        },
      ]);
    } finally {
      await first.destroy();
    }

    const second = await renderNotesController([file], scope);
    try {
      expect(
        expectValue(second.controllerRef.current).liveCommentsByFileId["alpha.ts"],
      ).toMatchObject([
        { id: "mcp:1", line: 10, summary: "Agent found this", restored: { state: "anchored" } },
      ]);
    } finally {
      await second.destroy();
    }
  });

  test("a saved human note is persisted with the quote it was written against", async () => {
    useTempNoteStore();
    const file = fixtureFile(10, "const line10 = 100;");
    const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };

    const { controllerRef, destroy, settle } = await renderNotesController([file], scope);

    try {
      await act(async () => {
        expectValue(controllerRef.current).startUserNote("alpha.ts", 0);
      });
      await settle();
      await act(async () => {
        expectValue(controllerRef.current).updateDraftNote("This looks wrong");
      });
      await settle();
      await act(async () => {
        expectValue(controllerRef.current).saveDraftNote();
      });
      await settle();

      expect(readNotes(scope)).toMatchObject([
        {
          filePath: "alpha.ts",
          summary: "This looks wrong",
          source: "user",
          anchorText: "const line10 = 100;",
        },
      ]);
    } finally {
      await destroy();
    }
  });

  test("removing a note removes it from the store too", async () => {
    useTempNoteStore();
    const file = fixtureFile(10, "const line10 = 100;");
    const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };
    writeNotes(scope, [storedNoteFor(file, { id: "mcp:1", line: 10, source: "mcp" })]);

    const { controllerRef, destroy, settle } = await renderNotesController([file], scope);

    try {
      await act(async () => {
        expectValue(controllerRef.current).removeLiveComment("mcp:1");
      });
      await settle();

      expect(readNotes(scope)).toEqual([]);
      expect(expectValue(controllerRef.current).restoredNotes).toEqual([]);
    } finally {
      await destroy();
    }
  });

  test("clearing the review also drops notes that resolved to nowhere", async () => {
    useTempNoteStore();
    const authored = fixtureFile(10, "const line10 = 100;");
    const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };
    writeNotes(scope, [
      storedNoteFor(authored, { id: "mcp:1", line: 10, source: "mcp" }),
      { ...storedNoteFor(authored, { id: "mcp:2", line: 10, source: "mcp" }), filePath: "gone.ts" },
    ]);

    const { controllerRef, destroy, settle } = await renderNotesController([authored], scope);

    try {
      expect(expectValue(controllerRef.current).restoredNotes.map((entry) => entry.state)).toEqual([
        "anchored",
        "orphaned",
      ]);

      await act(async () => {
        expectValue(controllerRef.current).clearLiveComments();
      });
      await settle();

      expect(readNotes(scope)).toEqual([]);
    } finally {
      await destroy();
    }
  });
});

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString("utf8").trim() || `git ${args.join(" ")}`);
  }
}

describe("note persistence through the real loader path", () => {
  test("a note added to a working-tree review returns to the next load of that worktree", async () => {
    useTempNoteStore();
    const repo = createTempDir("hunk-notes-repo-");
    git(repo, "init", "--initial-branch", "master");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "alpha.ts"), lines(...BASE_LINES));
    git(repo, "add", "alpha.ts");
    git(repo, "commit", "-m", "initial");
    const changed = [...BASE_LINES];
    changed[9] = "const line10 = 100;";
    writeFileSync(join(repo, "alpha.ts"), lines(...changed));

    const load = () =>
      loadAppBootstrap(
        { kind: "vcs", staged: false, options: { mode: "auto" } },
        { cwd: repo, vcsCatalog: getBundledVcsCatalog() },
      );

    const bootstrap = await load();
    expect(bootstrap.noteScope?.reviewTarget).toBe("diff");
    expect(bootstrap.noteScope?.worktreeRoot).toBe(repo);

    const first = await renderNotesController(bootstrap.changeset.files, bootstrap.noteScope);
    try {
      await act(async () => {
        expectValue(first.controllerRef.current).addLiveComment(
          { filePath: "alpha.ts", hunkIndex: 0, summary: "Reviewed here" },
          "mcp:1",
        );
      });
      await first.settle();
    } finally {
      await first.destroy();
    }

    // Exactly one store file, and nothing written inside the repository.
    expect(readdirSync(join(process.env.XDG_STATE_HOME!, "hunkt", "notes"))).toHaveLength(1);
    expect(existsSync(join(repo, ".hunkt"))).toBe(false);

    const reloaded = await load();
    const second = await renderNotesController(reloaded.changeset.files, reloaded.noteScope);
    try {
      const restored = expectValue(second.controllerRef.current).restoredNotes;
      expect(restored).toMatchObject([{ state: "anchored", note: { summary: "Reviewed here" } }]);
      expect(restored[0]?.placement?.line).toBe(10);
      expect(
        expectValue(second.controllerRef.current).liveCommentsByFileId[
          restored[0]!.placement!.fileId
        ],
      ).toHaveLength(1);
    } finally {
      await second.destroy();
    }
  }, 20_000);
});
