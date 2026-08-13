import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import type { DiffSide } from "../liveComments";
import type { CliInput, DiffFile } from "../types";
import {
  captureReviewNoteAnchor,
  createNoteStoreWriter,
  resolveNoteScope,
  resolveStoredNotes,
  reviewSideLines,
} from "./session";
import type { NoteScope } from "./store";
import type { StoredNote } from "./types";

const BASE_LINES = Array.from(
  { length: 30 },
  (_, index) => `const line${index + 1} = ${index + 1};`,
);

/** Build the 30-line fixture with one line replaced, so exactly one hunk exists. */
function changedAt(line: number, value: string) {
  const after = [...BASE_LINES];
  after[line - 1] = value;
  return after;
}

function fixtureFile(after: string[], path = "example.ts"): DiffFile {
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...BASE_LINES),
    context: 3,
    id: path,
    path,
  });
}

/** Author one note the way the controller does, quoting the file it was written against. */
function storedNote(
  file: DiffFile,
  {
    side = "new",
    line,
    source = "user",
    id = "note-1",
  }: { side?: DiffSide; line: number; source?: string; id?: string },
): StoredNote {
  return {
    id,
    filePath: file.path,
    side,
    line,
    summary: "Check this",
    source,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...captureReviewNoteAnchor(file, side, line),
  };
}

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

describe("reviewSideLines", () => {
  test("indexes each line by its own line number and leaves the diff's gaps empty", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));
    const lineTexts = reviewSideLines(file, "new");

    expect(lineTexts[9]).toBe("const line10 = 100;");
    expect(lineTexts[6]).toBe("const line7 = 7;");
    expect(lineTexts[12]).toBe("const line13 = 13;");
    expect(lineTexts[5]).toBeUndefined();
    expect(lineTexts[13]).toBeUndefined();
  });

  test("reads the before-image from the same hunks", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));

    expect(reviewSideLines(file, "old")[9]).toBe("const line10 = 10;");
  });
});

describe("captureReviewNoteAnchor", () => {
  test("quotes three lines on each side of the anchor", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));

    expect(captureReviewNoteAnchor(file, "new", 10)).toEqual({
      anchorText: "const line10 = 100;",
      prefixText: "const line7 = 7;\nconst line8 = 8;\nconst line9 = 9;",
      suffixText: "const line11 = 11;\nconst line12 = 12;\nconst line13 = 13;",
    });
  });

  test("stops the quote where the diff stops carrying lines", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));

    // Line 7 opens the hunk, so nothing above it is available to quote.
    expect(captureReviewNoteAnchor(file, "new", 7)).toEqual({
      anchorText: "const line7 = 7;",
      prefixText: "",
      suffixText: "const line8 = 8;\nconst line9 = 9;\nconst line10 = 100;",
    });
  });
});

describe("resolveStoredNotes", () => {
  test("an unchanged review anchors the note at its own line", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));
    const note = storedNote(file, { line: 10 });

    expect(resolveStoredNotes([note], [fixtureFile(changedAt(10, "const line10 = 100;"))])).toEqual(
      [
        {
          note,
          state: "anchored",
          confidence: "high",
          placement: {
            fileId: "example.ts",
            filePath: "example.ts",
            hunkIndex: 0,
            side: "new",
            line: 10,
          },
        },
      ],
    );
  });

  test("an edit above the note moves it to where its text now sits", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const note = storedNote(authored, { line: 10 });
    const shifted = fixtureFile([
      "const inserted1 = 1;",
      "const inserted2 = 2;",
      ...changedAt(10, "const line10 = 100;"),
    ]);

    const [resolved] = resolveStoredNotes([note], [shifted]);

    expect(resolved?.state).toBe("moved");
    expect(resolved?.placement?.line).toBe(12);
    expect(reviewSideLines(shifted, "new")[11]).toBe("const line10 = 100;");
  });

  test("a reindent of the anchored line keeps the note anchored", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const note = storedNote(authored, { line: 10 });
    const reindented = fixtureFile(changedAt(10, "    const line10 = 100;"));

    const [resolved] = resolveStoredNotes([note], [reindented]);

    expect(resolved?.state).toBe("anchored");
    expect(resolved?.placement?.line).toBe(10);
  });

  test("an edit to the anchored line itself degrades the note instead of moving it", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const note = storedNote(authored, { line: 10 });

    const [resolved] = resolveStoredNotes(
      [note],
      [fixtureFile(changedAt(10, "const line10 = 999;"))],
    );

    expect(resolved).toEqual({ note, state: "unanchored", confidence: "high" });
  });

  test("a file missing from the review orphans its notes", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const note = storedNote(authored, { line: 10 });

    const [resolved] = resolveStoredNotes(
      [note],
      [fixtureFile(changedAt(10, "const line10 = 100;"), "other.ts")],
    );

    expect(resolved).toEqual({ note, state: "orphaned", confidence: "high" });
  });

  test("a renamed file still carries the notes taken against its old path", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const note = storedNote(authored, { line: 10 });
    const renamed = createTestDiffFile({
      after: lines(...changedAt(10, "const line10 = 100;")),
      before: lines(...BASE_LINES),
      context: 3,
      id: "renamed",
      path: "renamed.ts",
      previousPath: "example.ts",
    });

    expect(resolveStoredNotes([note], [renamed])[0]?.placement?.filePath).toBe("renamed.ts");
  });

  test("a note on a deleted line comes back on the side that still shows it", () => {
    const deleted = fixtureFile(BASE_LINES.filter((_, index) => index !== 9));
    const note = storedNote(deleted, { side: "old", line: 10 });

    const [resolved] = resolveStoredNotes(
      [note],
      [fixtureFile(BASE_LINES.filter((_, index) => index !== 9))],
    );

    expect(resolved?.state).toBe("anchored");
    expect(resolved?.placement).toEqual({
      fileId: "example.ts",
      filePath: "example.ts",
      hunkIndex: 0,
      side: "old",
      line: 10,
    });
  });

  test("duplicate anchor text picks the nearest match and reports low confidence", () => {
    const duplicated = [...BASE_LINES];
    duplicated[9] = "const duplicate = 0;";
    duplicated[20] = "const duplicate = 0;";
    const file = fixtureFile(duplicated);
    // Stored one line off its text, with the anchor alone quoted, so both copies
    // stay candidates once the text at the shifted line fails to confirm.
    const note: StoredNote = {
      ...storedNote(file, { line: 11 }),
      anchorText: "const duplicate = 0;",
      prefixText: undefined,
      suffixText: undefined,
    };

    const [resolved] = resolveStoredNotes([note], [file]);

    expect(resolved?.confidence).toBe("low");
    expect(resolved?.placement?.line).toBe(10);
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
