import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPtyHarness, lineIndexOf, measureKeyScroll } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(30_000);

const tempDirs: string[] = [];

afterEach(() => {
  harness.cleanup();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeText(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Build a private config home whose hunkt config carries the given TOML. */
function createConfigHome(configToml: string) {
  const home = makeTempDir("hunk-pty-keys-config-");
  writeText(join(home, "hunk", "config.toml"), configToml);
  return home;
}

/** Build a one-hunk file pair tall enough that the review has somewhere to scroll. */
function createTallFilePair() {
  const dir = makeTempDir("hunk-pty-keys-tall-");
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");

  const numbered = (offset: number) =>
    Array.from(
      { length: 18 },
      (_, index) =>
        `export const line${String(index + 1).padStart(2, "0")} = ${index + 1 + offset};`,
    ).join("\n") + "\n";

  writeText(before, numbered(0));
  writeText(after, numbered(100));

  return { dir, before, after };
}

/** Build a small annotated pair for the note layer toggles. */
function createAnnotatedFilePair() {
  const dir = makeTempDir("hunk-pty-keys-note-");
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const agentContext = join(dir, "agent.json");

  writeText(before, "export const answer = 41;\n");
  writeText(after, "export const answer = 42;\nexport const added = true;\n");
  writeText(
    agentContext,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "after.ts",
          annotations: [{ newRange: [2, 2], summary: "SIDEBAR NOTE ONE" }],
        },
      ],
    }),
  );

  return { dir, before, after, agentContext };
}

/** Build a pair whose second hunk carries one note anchored at line 11. */
function createAnchoredNotePair() {
  const dir = makeTempDir("hunk-pty-keys-anchor-");
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const agentContext = join(dir, "agent.json");

  const beforeLines = Array.from(
    { length: 12 },
    (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[1] = "export const line02 = 200;";
  afterLines[10] = "export const line11 = 1100;";

  writeText(before, `${beforeLines.join("\n")}\n`);
  writeText(after, `${afterLines.join("\n")}\n`);
  writeText(
    agentContext,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "after.ts",
          annotations: [{ newRange: [11, 11], summary: "OMEGA-ANCHOR-NOTE" }],
        },
      ],
    }),
  );

  return { dir, before, after, agentContext };
}

/**
 * Build a pair whose second hunk carries two notes listed in non-anchor order.
 *
 * The sidecar names the line-70 note before the line-35 note, so a consumer that
 * trusts sidecar order and one that trusts anchor order pick different notes. The
 * anchors sit further apart than a 24-row viewport, so only one note card can be
 * on screen at a time and the revealed note is unambiguous.
 */
function createTwoNoteHunkPair() {
  const dir = makeTempDir("hunk-pty-keys-reveal-");
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const agentContext = join(dir, "agent.json");

  const beforeLines = Array.from(
    { length: 90 },
    (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[1] = "export const line02 = 200;";
  for (let line = 30; line <= 75; line += 1) {
    afterLines[line - 1] = `export const line${String(line).padStart(2, "0")} = ${line * 100};`;
  }

  writeText(before, `${beforeLines.join("\n")}\n`);
  writeText(after, `${afterLines.join("\n")}\n`);
  writeText(
    agentContext,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "after.ts",
          annotations: [
            { newRange: [70, 70], summary: "HIGH-NOTE-SEVENTY" },
            { newRange: [35, 35], summary: "LOW-NOTE-THIRTYFIVE" },
          ],
        },
      ],
    }),
  );

  return { dir, before, after, agentContext };
}

/** Open a draft at the current line, read its side-and-line label, and cancel it. */
async function readCursorLabel(session: Awaited<ReturnType<typeof harness.launchHunk>>) {
  await session.press("c");
  const frame = await session.waitForText(/Draft note/, { timeout: 5_000 });
  const row = frame.split("\n").find((line) => line.includes("Draft note")) ?? "";
  const match = /\s([LR])(\d+)\s*─/.exec(row);
  await session.press("escape");
  await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);
  if (!match) {
    throw new Error(`The draft row carried no cursor label: ${JSON.stringify(row)}`);
  }
  return `${match[1]}${match[2]}`;
}

/** Assert the draft note the cursor anchors opens between two rendered rows. */
async function expectDraftBetween(
  session: Awaited<ReturnType<typeof harness.launchHunk>>,
  aboveNeedle: string,
  belowNeedle: string,
) {
  await session.press("c");
  const draft = await session.waitForText(/Draft note/, { timeout: 5_000 });
  const draftRow = lineIndexOf(draft, "Draft note");
  expect(draftRow).toBeGreaterThan(lineIndexOf(draft, aboveNeedle));
  const belowRow = lineIndexOf(draft, belowNeedle);
  if (belowRow >= 0) {
    expect(draftRow).toBeLessThan(belowRow);
  }
  await session.press("escape");
  await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);
}

describe("PTY keybindings", () => {
  test("a toggles the all-notes sidebar and i toggles inline notes", async () => {
    const fixture = createAnnotatedFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "stack",
        "--agent-context",
        fixture.agentContext,
      ],
      cols: 150,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("SIDEBAR NOTE ONE");
      await harness.ensureKeyboardIsLive(session);

      await session.press("i");
      await session.waitForText(/SIDEBAR NOTE ONE/, { timeout: 5_000 });

      await session.press("i");
      await harness.waitForSnapshot(session, (text) => !text.includes("SIDEBAR NOTE ONE"), 5_000);

      await session.press("a");
      const withPane = await session.waitForText(/R2\s+SIDEBAR NOTE ONE/, { timeout: 5_000 });
      // The row is the pane's list entry, not an inline card: the layer is still off.
      expect(harness.countMatches(withPane, /SIDEBAR NOTE ONE/g)).toBe(1);

      await session.press("a");
      await harness.waitForSnapshot(session, (text) => !text.includes("SIDEBAR NOTE ONE"), 5_000);
    } finally {
      session.close();
    }
  });

  test("j and k scroll the viewport while the current line is off, the default", async () => {
    const fixture = createTallFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);

      expect(await measureKeyScroll(session, "j", 12)).toBe(1);
      expect(await measureKeyScroll(session, "j", 12)).toBe(1);
      expect(await measureKeyScroll(session, "k", 12)).toBe(-1);
    } finally {
      session.close();
    }
  });

  test("j and k move the current line instead once cursor_line is on in config", async () => {
    const fixture = createTallFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 120,
      rows: 24,
      env: { XDG_CONFIG_HOME: createConfigHome('cursor_line = "row"\n') },
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);

      await session.press("c");
      const draftAtTop = await session.waitForText(/Draft note/, { timeout: 5_000 });
      const draftRowAtTop = lineIndexOf(draftAtTop, "Draft note");
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);

      // The viewport stays put while the marker walks down it.
      expect(await measureKeyScroll(session, "j", 12)).toBe(0);
      expect(await measureKeyScroll(session, "j", 12)).toBe(0);
      expect(await measureKeyScroll(session, "j", 12)).toBe(0);

      // The draft opens at the current line, so a lower draft proves the marker moved.
      await session.press("c");
      const draftAfterSteps = await session.waitForText(/Draft note/, { timeout: 5_000 });
      expect(lineIndexOf(draftAfterSteps, "Draft note")).toBeGreaterThan(draftRowAtTop);
    } finally {
      session.close();
    }
  });

  test("a click on a diff row moves the current line there", async () => {
    const fixture = createTallFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 120,
      rows: 24,
      env: { XDG_CONFIG_HOME: createConfigHome('cursor_line = "row"\n') },
    });

    try {
      await session.waitForText(/line05 = 5;/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);
      expect(await readCursorLabel(session)).toBe("L1");

      await session.click(/line05 = 5;/);
      // Toggling help clears the click's hover target so the draft reads the cursor.
      await harness.ensureKeyboardIsLive(session);

      expect(await readCursorLabel(session)).toBe("L5");
    } finally {
      session.close();
    }
  });

  test("selecting an all-notes row puts the current line on that note's anchor", async () => {
    const fixture = createAnchoredNotePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "stack",
        "--agent-context",
        fixture.agentContext,
      ],
      cols: 150,
      rows: 26,
      env: { XDG_CONFIG_HOME: createConfigHome('cursor_line = "row"\n') },
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);

      await session.press("a");
      await session.waitForText(/R11\s+OMEGA-ANCHOR-NOTE/, { timeout: 5_000 });

      await session.click(/OMEGA-ANCHOR-NOTE/, { first: true });
      // Selecting the row turns the inline layer on, so the card joins the list entry.
      await harness.waitForSnapshot(
        session,
        (text) => harness.countMatches(text, /OMEGA-ANCHOR-NOTE/g) === 2,
        5_000,
      );

      await harness.ensureKeyboardIsLive(session);
      await expectDraftBetween(session, "line11 = 1100;", "line12 = 12;");
    } finally {
      session.close();
    }
  });

  test("an annotated-hunk jump reveals the same note the cursor lands on", async () => {
    const fixture = createTwoNoteHunkPair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "stack",
        "--agent-context",
        fixture.agentContext,
        "--agent-notes",
      ],
      cols: 150,
      rows: 24,
      env: { XDG_CONFIG_HOME: createConfigHome('cursor_line = "row"\n') },
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("LOW-NOTE-THIRTYFIVE");
      expect(initial).not.toContain("HIGH-NOTE-SEVENTY");
      await harness.ensureKeyboardIsLive(session);

      // One policy picks the note: the lowest anchor line wins even though the
      // sidecar lists the line-70 note first. The reveal and the cursor must both
      // land on that same note.
      await session.press("}");
      const revealed = await session.waitForText(/LOW-NOTE-THIRTYFIVE/, { timeout: 5_000 });
      expect(revealed).not.toContain("HIGH-NOTE-SEVENTY");
      await expectDraftBetween(session, "line35 = 3500;", "line36 = 3600;");

      // Picking the other note from the all-notes list moves both the cursor and
      // the reveal onto it.
      await session.press("a");
      await session.waitForText(/R70\s+HIGH-NOTE-SEVENTY/, { timeout: 5_000 });
      await session.click(/HIGH-NOTE-SEVENTY/, { first: true });
      await harness.waitForSnapshot(
        session,
        (text) =>
          harness.countMatches(text, /HIGH-NOTE-SEVENTY/g) === 2 &&
          harness.countMatches(text, /LOW-NOTE-THIRTYFIVE/g) === 1,
        5_000,
      );

      await harness.ensureKeyboardIsLive(session);
      await expectDraftBetween(session, "line70 = 7000;", "line71 = 7100;");
    } finally {
      session.close();
    }
  });
});

describe("PTY menu dismissal", () => {
  test("an outside click closes the menu without moving the current line", async () => {
    const fixture = createTallFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 120,
      rows: 24,
      env: { XDG_CONFIG_HOME: createConfigHome('cursor_line = "row"\n') },
    });

    try {
      await session.waitForText(/line10 = 10;/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);
      expect(await readCursorLabel(session)).toBe("L1");

      await session.click(/Help/, { first: true });
      await session.waitForText(/Controls help/, { timeout: 5_000 });

      await session.click(/line10 = 10;/);
      await harness.waitForSnapshot(session, (text) => !text.includes("Controls help"), 5_000);

      // The dismissing click never reached the diff: the current line stayed put.
      await harness.ensureKeyboardIsLive(session);
      expect(await readCursorLabel(session)).toBe("L1");

      // The same click with no menu open does move the current line, so the check
      // above read a suppressed click rather than an inert target.
      await session.click(/line10 = 10;/);
      await harness.ensureKeyboardIsLive(session);
      expect(await readCursorLabel(session)).toBe("L10");
    } finally {
      session.close();
    }
  });

  test("the wheel dismisses an open menu and keeps scrolling", async () => {
    const fixture = createTallFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.ensureKeyboardIsLive(session);

      await session.click(/Help/, { first: true });
      await session.waitForText(/Controls help/, { timeout: 5_000 });

      // The first notch lands on the scrim and dismisses instead of dying there.
      await session.scrollDown(1, 30, 12);
      await harness.waitForSnapshot(session, (text) => !text.includes("Controls help"), 5_000);

      // With the menu gone the wheel reaches the review again and scrolls it.
      const before = (await session.text({ immediate: true })).split("\n");
      const anchor = before[12]?.trim() ?? "";
      expect(anchor.length).toBeGreaterThan(0);
      await session.scrollDown(3, 30, 12);
      await harness.waitForSnapshot(
        session,
        (text) => {
          const movedTo = text.split("\n").findIndex((line) => line.trim() === anchor);
          return movedTo >= 0 && movedTo < 12;
        },
        5_000,
      );
    } finally {
      session.close();
    }
  });
});
