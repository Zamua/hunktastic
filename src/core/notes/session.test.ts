import { describe, expect, test } from "bun:test";
import type { ReviewStoredNote } from "../review/state";
import type { CliInput } from "../types";
import { createNoteStoreWriter, resolveNoteScope, storedNotesForReviewState } from "./session";
import type { NoteScope, StoredNote } from "./types";

const vcsOptions = { mode: "auto" } as const;

describe("resolveNoteScope", () => {
  test("refuses reviews with no stable identity", () => {
    const inputs: CliInput[] = [
      { kind: "diff", left: "a.ts", right: "b.ts", options: vcsOptions },
      { kind: "difftool", left: "a.ts", right: "b.ts", options: vcsOptions },
      { kind: "patch", file: "-", options: vcsOptions },
    ];

    for (const input of inputs) {
      expect(resolveNoteScope(input, "/repo")).toBeUndefined();
    }
  });

  test("refuses a VCS review whose repo root is unknown", () => {
    expect(
      resolveNoteScope({ kind: "vcs", staged: false, options: vcsOptions }, undefined),
    ).toBeUndefined();
  });

  test("separates working tree, staged, range, and revision reviews", () => {
    const targets = (
      [
        { kind: "vcs", staged: false, options: vcsOptions },
        { kind: "vcs", staged: true, options: vcsOptions },
        { kind: "vcs", staged: false, range: "main..HEAD", options: vcsOptions },
        { kind: "show", ref: "HEAD~1", options: vcsOptions },
        { kind: "show", options: vcsOptions },
        { kind: "stash-show", ref: "stash@{0}", options: vcsOptions },
      ] satisfies CliInput[]
    ).map((input) => resolveNoteScope(input, process.cwd())?.reviewTarget);

    expect(targets).toEqual([
      "diff",
      "diff:staged",
      "diff:main..HEAD",
      "show:HEAD~1",
      "show:HEAD",
      "stash-show:stash@{0}",
    ]);
    expect(new Set(targets).size).toBe(targets.length);
  });

  test("a pathspec-filtered review keeps the notes of the tree it filters", () => {
    const all = resolveNoteScope(
      { kind: "vcs", staged: false, options: vcsOptions },
      process.cwd(),
    );
    const filtered = resolveNoteScope(
      { kind: "vcs", staged: false, pathspecs: ["src"], options: vcsOptions },
      process.cwd(),
    );

    expect(filtered).toEqual(all);
  });
});

describe("storedNotesForReviewState", () => {
  /** Build one quoted stored-note entry the way the store holds it. */
  function createTestEntry(
    id: string,
    overrides: { source?: ReviewStoredNote["note"]["source"]; quote?: boolean } = {},
  ): ReviewStoredNote {
    return {
      note: {
        id,
        source: overrides.source ?? "agent",
        originalSource: overrides.source === "user" ? "user" : "mcp",
        fileKey: "alpha",
        anchor: {
          newRange: [10, 10],
          preferred: { side: "new", line: 10 },
          intersectingHunkIndices: [0],
          ownerHunkIndex: 0,
        },
        summary: `note ${id}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        editable: overrides.source === "user",
      },
      resolution: "active",
      ...(overrides.quote === false
        ? {}
        : {
            quote: {
              filePath: "alpha.ts",
              side: "new",
              line: 10,
              anchorText: "const line10 = 10;",
              prefixText: "const line9 = 9;",
              suffixText: "const line11 = 11;",
            },
          }),
    };
  }

  test("writes back the authored coordinates and quote, not the resolved anchor", () => {
    const entry = createTestEntry("mcp:1");
    // The anchor moved; the persisted record still carries the authored coordinates.
    entry.note.anchor = {
      newRange: [13, 13],
      preferred: { side: "new", line: 13 },
      intersectingHunkIndices: [0],
      ownerHunkIndex: 0,
    };

    expect(storedNotesForReviewState({ liveNotes: [entry], userNotes: [] })).toEqual([
      {
        id: "mcp:1",
        filePath: "alpha.ts",
        side: "new",
        line: 10,
        summary: "note mcp:1",
        source: "mcp",
        createdAt: "2026-01-01T00:00:00.000Z",
        anchorText: "const line10 = 10;",
        prefixText: "const line9 = 9;",
        suffixText: "const line11 = 11;",
      },
    ]);
  });

  test("persists live notes before user notes and skips quoteless entries", () => {
    const notes = storedNotesForReviewState({
      liveNotes: [createTestEntry("mcp:1"), createTestEntry("mcp:2", { quote: false })],
      userNotes: [createTestEntry("user:1", { source: "user" })],
    });

    expect(notes.map((note) => note.id)).toEqual(["mcp:1", "user:1"]);
    expect(notes[1]?.source).toBe("user");
  });
});

describe("createNoteStoreWriter", () => {
  const scope: NoteScope = { worktreeRoot: "/repo", reviewTarget: "diff" };

  function fakeSchedule() {
    const tasks: Array<() => void> = [];
    return {
      schedule: (task: () => void) => {
        tasks.push(task);
      },
      run: () => {
        while (tasks.length > 0) {
          tasks.shift()?.();
        }
      },
      get pending() {
        return tasks.length;
      },
    };
  }

  test("coalesces repeated saves into one write of the final set", () => {
    const written: StoredNote[][] = [];
    const scheduler = fakeSchedule();
    const writer = createNoteStoreWriter(scope, {
      schedule: scheduler.schedule,
      write: (_scope, notes) => {
        written.push(notes);
        return true;
      },
    });

    writer.save([{ id: "a" } as StoredNote]);
    writer.save([{ id: "a" } as StoredNote, { id: "b" } as StoredNote]);

    expect(scheduler.pending).toBe(1);
    expect(written).toHaveLength(0);

    scheduler.run();

    expect(written).toHaveLength(1);
    expect(written[0]?.map((note) => note.id)).toEqual(["a", "b"]);
  });

  test("reports a failed write without throwing", () => {
    const failures: string[] = [];
    const scheduler = fakeSchedule();
    const writer = createNoteStoreWriter(scope, {
      schedule: scheduler.schedule,
      write: () => false,
      onFailure: (message) => failures.push(message),
    });

    writer.save([{ id: "a" } as StoredNote]);
    scheduler.run();

    expect(failures).toHaveLength(1);
  });

  test("disposing writes whatever was still pending", () => {
    const written: StoredNote[][] = [];
    const scheduler = fakeSchedule();
    const writer = createNoteStoreWriter(scope, {
      schedule: scheduler.schedule,
      write: (_scope, notes) => {
        written.push(notes);
        return true;
      },
    });

    writer.save([{ id: "a" } as StoredNote]);
    writer.dispose();

    expect(written).toHaveLength(1);

    writer.save([{ id: "b" } as StoredNote]);
    scheduler.run();

    expect(written).toHaveLength(1);
  });
});
