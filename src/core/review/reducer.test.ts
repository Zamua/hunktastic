import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import {
  createTestReviewDocument,
  createTestReviewState,
  createTestStoredNote,
} from "../../../test/helpers/review-store-helpers";
import type { StoredNote } from "../notes/types";
import { reviewLineAnchor } from "./anchors";
import { projectReviewDocument } from "./document";
import { reduceReviewState } from "./reducer";
import {
  createInitialReviewState,
  reviewNoteAnchorLine,
  type ReviewState,
  type ReviewStoredNote,
} from "./state";
import type { ReviewDocumentV1 } from "./types";

/** Apply several actions in order, as one dispatch batch would. */
function reduceAll(state: ReviewState, ...actions: Parameters<typeof reduceReviewState>[1][]) {
  return actions.reduce(reduceReviewState, state);
}

describe("selection", () => {
  test("clamps the hunk index into the addressed file", () => {
    const next = reduceReviewState(createTestReviewState([{ key: "alpha", hunkCount: 2 }]), {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 7,
    });

    expect(next.selection).toEqual({ fileKey: "alpha", hunkIndex: 1 });
  });

  test("keeps a file with no hunks selectable", () => {
    const next = reduceReviewState(createTestReviewState([{ key: "alpha", hunkCount: 0 }]), {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 3,
    });

    expect(next.selection).toEqual({ fileKey: "alpha", hunkIndex: 0 });
  });

  test("ignores a selection of a file the review does not contain", () => {
    const state = createTestReviewState();

    expect(
      reduceReviewState(state, {
        type: "selection/select",
        fileKey: "missing",
        hunkIndex: 0,
      }),
    ).toBe(state);
  });

  test("advances only the reveal counter the requested anchor belongs to", () => {
    const state = createTestReviewState();
    const hunkRevealed = reduceReviewState(state, {
      type: "selection/select",
      fileKey: "beta",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });
    const fileRevealed = reduceReviewState(hunkRevealed, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "file-top", scrollToNote: false },
    });

    expect(hunkRevealed.reveal).toEqual({ fileTopToken: 0, hunkToken: 1, scrollToNote: false });
    expect(fileRevealed.reveal).toEqual({ fileTopToken: 1, hunkToken: 1, scrollToNote: false });
  });

  test("re-reveals the same target so a repeated request still scrolls", () => {
    const state = createTestReviewState();
    const first = reduceReviewState(state, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });
    const second = reduceReviewState(first, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });

    expect(second.reveal.hunkToken).toBe(first.reveal.hunkToken + 1);
  });

  test("leaves the viewport alone when no reveal anchor is named", () => {
    const state = createTestReviewState();
    const next = reduceReviewState(state, {
      type: "selection/select",
      fileKey: "beta",
      hunkIndex: 1,
      reveal: { anchor: "none", scrollToNote: false },
    });

    expect(next.selection).toEqual({ fileKey: "beta", hunkIndex: 1 });
    expect(next.reveal).toEqual(state.reveal);
  });

  test("retires a note-scroll request even when the selection is unchanged", () => {
    const noteSelected = reduceReviewState(createTestReviewState(), {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: true },
    });
    const anchored = reduceReviewState(noteSelected, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "none", scrollToNote: false },
    });

    expect(anchored.reveal.scrollToNote).toBe(false);
    expect(anchored.reveal.hunkToken).toBe(noteSelected.reveal.hunkToken);
  });
});

describe("document reconciliation", () => {
  test("drops expansion and loaded source for a file whose source identity changed", () => {
    const state = reduceAll(
      createTestReviewState([
        { key: "alpha", sourceIdentity: "source-1", sourceAttested: true },
        { key: "beta", sourceIdentity: "source-1", sourceAttested: true },
      ]),
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
      { type: "expansion/toggle", fileKey: "beta", gapId: "before:1", expanded: true },
      {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "a" },
      },
      {
        type: "expansion/set-source-status",
        fileKey: "beta",
        status: { kind: "loaded", text: "b" },
      },
    );

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument([
        { key: "alpha", sourceIdentity: "source-2", sourceAttested: true },
        { key: "beta", sourceIdentity: "source-1", sourceAttested: true },
      ]),
    });

    expect(next.expandedGaps).toEqual([{ fileKey: "beta", gapId: "before:1", expanded: true }]);
    expect(next.sourceStatusByFileKey).toEqual({ beta: { kind: "loaded", text: "b" } });
  });

  test("drops unattested loaded source on reconcile while keeping the gap open", () => {
    const state = reduceAll(
      createTestReviewState([{ key: "alpha", sourceIdentity: "source-1" }]),
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
      {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "a" },
      },
    );

    // Same identity, but no reader attestation: the diff not moving proves nothing about
    // the full source behind it, so the cached text goes and the open gap refetches.
    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument([{ key: "alpha", sourceIdentity: "source-1" }]),
    });

    expect(next.expandedGaps).toEqual([{ fileKey: "alpha", gapId: "before:1", expanded: true }]);
    expect(next.sourceStatusByFileKey).toEqual({});
  });

  test("drops file-scoped state for a file the new document retired", () => {
    const state = reduceReviewState(createTestReviewState(["alpha", "beta"]), {
      type: "expansion/toggle",
      fileKey: "beta",
      gapId: "before:1",
      expanded: true,
    });

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument(["alpha"]),
    });

    expect(next.expandedGaps).toEqual([]);
  });

  test("keeps notes and the active draft across a reload", () => {
    const state = reduceAll(
      createTestReviewState(),
      { type: "notes/add-live", notes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })] },
      {
        type: "draft/start",
        draft: {
          id: "draft-1",
          fileKey: "alpha",
          hunkIndex: 0,
          side: "new",
          line: 4,
          body: "wip",
        },
      },
    );

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument(["alpha", "beta"]),
    });

    expect(next.liveNotes).toHaveLength(1);
    expect(next.draftNote?.body).toBe("wip");
  });
});

describe("notes", () => {
  test("appends live notes in arrival order and removes them by id", () => {
    const added = reduceReviewState(createTestReviewState(), {
      type: "notes/add-live",
      notes: [
        createTestStoredNote({ id: "live-1", fileKey: "alpha" }),
        createTestStoredNote({ id: "live-2", fileKey: "beta" }),
      ],
    });
    const removed = reduceReviewState(added, { type: "notes/remove-live", noteId: "live-1" });

    expect(added.liveNotes.map((entry) => entry.note.id)).toEqual(["live-1", "live-2"]);
    expect(removed.liveNotes.map((entry) => entry.note.id)).toEqual(["live-2"]);
  });

  test("ignores removal of an unknown note", () => {
    const state = createTestReviewState();

    expect(reduceReviewState(state, { type: "notes/remove-live", noteId: "nope" })).toBe(state);
  });

  test("clears one file's live notes while leaving user notes alone", () => {
    const state = reduceAll(
      createTestReviewState(),
      {
        type: "notes/add-live",
        notes: [
          createTestStoredNote({ id: "live-1", fileKey: "alpha" }),
          createTestStoredNote({ id: "live-2", fileKey: "beta" }),
        ],
      },
      {
        type: "draft/start",
        draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 1, body: "x" },
      },
      {
        type: "draft/save",
        note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
      },
    );

    const cleared = reduceReviewState(state, { type: "notes/clear", fileKey: "alpha" });

    expect(cleared.liveNotes.map((entry) => entry.note.id)).toEqual(["live-2"]);
    expect(cleared.userNotes.map((entry) => entry.note.id)).toEqual(["user-1"]);
  });

  test("clears user notes too when the caller asks for them", () => {
    const state = reduceAll(
      createTestReviewState(),
      { type: "notes/add-live", notes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })] },
      {
        type: "draft/start",
        draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 1, body: "x" },
      },
      {
        type: "draft/save",
        note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
      },
    );

    const cleared = reduceReviewState(state, { type: "notes/clear", includeUser: true });

    expect(cleared.liveNotes).toEqual([]);
    expect(cleared.userNotes).toEqual([]);
  });
});

describe("drafts", () => {
  const draft = {
    id: "draft-1",
    fileKey: "alpha",
    hunkIndex: 0,
    side: "new" as const,
    line: 4,
    newRange: [4, 4] as [number, number],
    body: "",
  };

  test("edits and cancels the active draft", () => {
    const started = reduceReviewState(createTestReviewState(), { type: "draft/start", draft });
    const edited = reduceReviewState(started, { type: "draft/update", body: "hello" });
    const cancelled = reduceReviewState(edited, { type: "draft/cancel" });

    expect(edited.draftNote?.body).toBe("hello");
    expect(cancelled.draftNote).toBeNull();
  });

  test("ignores edits with no draft in progress", () => {
    const state = createTestReviewState();

    expect(reduceReviewState(state, { type: "draft/update", body: "hello" })).toBe(state);
    expect(reduceReviewState(state, { type: "draft/cancel" })).toBe(state);
  });

  test("saving retires the draft and appends one user note", () => {
    const started = reduceReviewState(createTestReviewState(), { type: "draft/start", draft });
    const saved = reduceReviewState(started, {
      type: "draft/save",
      note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
    });

    expect(saved.draftNote).toBeNull();
    expect(saved.userNotes.map((entry) => entry.note.id)).toEqual(["user-1"]);
  });
});

describe("expansion", () => {
  test("collapses a gap without forgetting the other gaps of the file", () => {
    const state = reduceAll(
      createTestReviewState(),
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:2", expanded: true },
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: false },
    );

    expect(state.expandedGaps).toEqual([
      { fileKey: "alpha", gapId: "before:1", expanded: false },
      { fileKey: "alpha", gapId: "before:2", expanded: true },
    ]);
  });

  test("ignores a toggle that repeats the current expansion", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
      expanded: true,
    });

    expect(
      reduceReviewState(state, {
        type: "expansion/toggle",
        fileKey: "alpha",
        gapId: "before:1",
        expanded: true,
      }),
    ).toBe(state);
  });

  test("compares source status by value so a repeated load does not re-render", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "expansion/set-source-status",
      fileKey: "alpha",
      status: { kind: "loaded", text: "source" },
    });

    expect(
      reduceReviewState(state, {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "source" },
      }),
    ).toBe(state);
    expect(
      reduceReviewState(state, {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "changed" },
      }),
    ).not.toBe(state);
  });
});

describe("filter and note visibility", () => {
  test("sets the shared filter without touching selection", () => {
    const state = createTestReviewState();
    const next = reduceReviewState(state, { type: "filter/set", filter: "alpha" });

    expect(next.filter).toBe("alpha");
    expect(next.selection).toEqual(state.selection);
  });

  test("ignores a repeated filter or visibility value", () => {
    const state = createTestReviewState();

    expect(reduceReviewState(state, { type: "filter/set", filter: "" })).toBe(state);
    expect(reduceReviewState(state, { type: "notes/set-visibility", visible: false })).toBe(state);
    expect(
      reduceReviewState(state, { type: "notes/set-visibility", visible: true }).showAgentNotes,
    ).toBe(true);
  });
});

describe("note re-anchoring", () => {
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

  function projectFixture(after: string[], path = "example.ts"): ReviewDocumentV1 {
    return projectReviewDocument([
      createTestDiffFile({
        after: lines(...after),
        before: lines(...BASE_LINES),
        context: 3,
        id: path,
        path,
      }),
    ]);
  }

  /** Author one live note the way the terminal does: anchored, active, and quoteless. */
  function authoredNote(document: ReviewDocumentV1, line: number, id = "mcp:1"): ReviewStoredNote {
    const file = document.files[0]!;
    return {
      note: {
        id,
        source: "agent",
        originalSource: "mcp",
        fileKey: file.key,
        anchor: reviewLineAnchor(file.hunks, { hunkIndex: 0, side: "new", line }),
        summary: "Check this",
        createdAt: "2026-01-01T00:00:00.000Z",
        editable: false,
      },
      resolution: "active",
    };
  }

  test("adding a note captures the quote it will re-anchor by", () => {
    const document = projectFixture(changedAt(10, "const line10 = 100;"));
    const state = reduceReviewState(createInitialReviewState(document), {
      type: "notes/add-live",
      notes: [authoredNote(document, 10)],
    });

    expect(state.liveNotes[0]?.quote).toEqual({
      filePath: "example.ts",
      side: "new",
      line: 10,
      anchorText: "const line10 = 100;",
      prefixText: "const line7 = 7;\nconst line8 = 8;\nconst line9 = 9;",
      suffixText: "const line11 = 11;\nconst line12 = 12;\nconst line13 = 13;",
    });
  });

  test("saving a draft captures the reviewer note's quote the same way", () => {
    const document = projectFixture(changedAt(10, "const line10 = 100;"));
    const file = document.files[0]!;
    const withDraft = reduceReviewState(createInitialReviewState(document), {
      type: "draft/start",
      draft: { id: "draft-1", fileKey: file.key, hunkIndex: 0, side: "new", line: 10, body: "x" },
    });

    const saved = reduceReviewState(withDraft, {
      type: "draft/save",
      note: {
        note: {
          id: "user:1",
          source: "user",
          originalSource: "user",
          fileKey: file.key,
          anchor: reviewLineAnchor(file.hunks, { hunkIndex: 0, side: "new", line: 10 }),
          summary: "x",
          author: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          editable: true,
        },
        resolution: "active",
      },
    });

    expect(saved.userNotes[0]?.quote?.anchorText).toBe("const line10 = 100;");
  });

  // The anti-silent-revert check for the reconcile wiring: a reload that moves the noted
  // line must move the anchor while the note stays active, a reload that deletes the
  // noted text must degrade the note, and a reload that drops the file must orphan it.
  // If reconcile stops running the resolver, every assertion below reads a stale anchor
  // reporting "active" and fails.
  test("document/reconcile re-anchors notes instead of leaving every anchor active", () => {
    const authored = projectFixture(changedAt(10, "const line10 = 100;"));
    const state = reduceReviewState(createInitialReviewState(authored), {
      type: "notes/add-live",
      notes: [authoredNote(authored, 10)],
    });

    // Three lines inserted above: the noted text now sits at line 13, and moved is active.
    const shifted = projectFixture([
      "const inserted1 = 1;",
      "const inserted2 = 2;",
      "const inserted3 = 3;",
      ...changedAt(10, "const line10 = 100;"),
    ]);
    const afterShift = reduceReviewState(state, {
      type: "document/reconcile",
      document: shifted,
    });
    expect(afterShift.liveNotes[0]?.resolution).toBe("active");
    expect(reviewLineAnchorOf(afterShift)).toEqual({ side: "new", line: 13 });

    // The anchor text is deleted from the file entirely: the note degrades to stale and
    // keeps its authored coordinate rather than pointing at unrelated moved code.
    const textGone = projectFixture(BASE_LINES.filter((_, index) => index !== 9));
    const afterDelete = reduceReviewState(afterShift, {
      type: "document/reconcile",
      document: textGone,
    });
    expect(afterDelete.liveNotes[0]?.resolution).toBe("stale");
    expect(reviewLineAnchorOf(afterDelete)).toEqual({ side: "new", line: 10 });

    // The file itself is gone: the note is orphaned, and comes back when the file does.
    const fileGone = projectFixture(changedAt(10, "const line10 = 100;"), "other.ts");
    const afterFileGone = reduceReviewState(afterDelete, {
      type: "document/reconcile",
      document: fileGone,
    });
    expect(afterFileGone.liveNotes[0]?.resolution).toBe("orphaned");

    const restoredFile = reduceReviewState(afterFileGone, {
      type: "document/reconcile",
      document: projectFixture(changedAt(10, "const line10 = 100;")),
    });
    expect(restoredFile.liveNotes[0]?.resolution).toBe("active");
    expect(reviewLineAnchorOf(restoredFile)).toEqual({ side: "new", line: 10 });
  });

  function reviewLineAnchorOf(state: ReviewState) {
    return reviewNoteAnchorLine(state.liveNotes[0]!.note);
  }

  test("reconciliation with unchanged content keeps note entry identity", () => {
    const authored = projectFixture(changedAt(10, "const line10 = 100;"));
    const state = reduceReviewState(createInitialReviewState(authored), {
      type: "notes/add-live",
      notes: [authoredNote(authored, 10)],
    });

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: projectFixture(changedAt(10, "const line10 = 100;")),
    });

    expect(next.liveNotes).toBe(state.liveNotes);
  });

  function storedRecord(overrides: Partial<StoredNote> = {}): StoredNote {
    return {
      id: "mcp:1",
      filePath: "example.ts",
      side: "new",
      line: 10,
      summary: "Check this",
      source: "mcp",
      createdAt: "2026-01-01T00:00:00.000Z",
      anchorText: "const line10 = 100;",
      prefixText: "const line7 = 7;\nconst line8 = 8;\nconst line9 = 9;",
      suffixText: "const line11 = 11;\nconst line12 = 12;\nconst line13 = 13;",
      ...overrides,
    };
  }

  test("notes/restore places persisted notes into the collections their sources own", () => {
    const document = projectFixture(changedAt(10, "const line10 = 100;"));
    const state = reduceReviewState(createInitialReviewState(document), {
      type: "notes/restore",
      notes: [
        storedRecord(),
        storedRecord({ id: "user:1", source: "user", line: 12, anchorText: "const line12 = 12;" }),
        storedRecord({ id: "mcp:2", filePath: "gone.ts" }),
      ],
    });

    expect(state.liveNotes.map((entry) => [entry.note.id, entry.resolution])).toEqual([
      ["mcp:1", "active"],
      ["mcp:2", "orphaned"],
    ]);
    expect(state.userNotes.map((entry) => [entry.note.id, entry.resolution])).toEqual([
      ["user:1", "active"],
    ]);
    expect(state.userNotes[0]?.note.editable).toBe(true);
    expect(state.liveNotes[0]?.note.fileKey).toBe(document.files[0]!.key);
    expect(state.liveNotes[0]?.quote?.anchorText).toBe("const line10 = 100;");
  });

  test("restoring the same ids again replaces rather than duplicates", () => {
    const document = projectFixture(changedAt(10, "const line10 = 100;"));
    const restore = {
      type: "notes/restore",
      notes: [storedRecord()],
    } as const;
    const once = reduceReviewState(createInitialReviewState(document), restore);
    const twice = reduceReviewState(once, restore);

    expect(twice.liveNotes.map((entry) => entry.note.id)).toEqual(["mcp:1"]);
  });

  test("notes/set-resolution records a verdict without moving the anchor", () => {
    const document = projectFixture(changedAt(10, "const line10 = 100;"));
    const state = reduceReviewState(createInitialReviewState(document), {
      type: "notes/add-live",
      notes: [authoredNote(document, 10)],
    });

    const next = reduceReviewState(state, {
      type: "notes/set-resolution",
      noteId: "mcp:1",
      resolution: "stale",
    });
    expect(next.liveNotes[0]?.resolution).toBe("stale");
    expect(next.liveNotes[0]?.note.anchor).toBe(state.liveNotes[0]!.note.anchor);

    // A repeat of the same verdict, or an unknown id, changes nothing at all.
    expect(
      reduceReviewState(next, {
        type: "notes/set-resolution",
        noteId: "mcp:1",
        resolution: "stale",
      }),
    ).toBe(next);
    expect(
      reduceReviewState(next, {
        type: "notes/set-resolution",
        noteId: "missing",
        resolution: "active",
      }),
    ).toBe(next);
  });
});
