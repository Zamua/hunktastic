import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness, sleep } from "./harness";

const harness = createPtyHarness();

// The heredoc case asserts token colors on Pierre-shaped partial hunks with context
// rows. The fork defaults the engine to difftastic (restructured hunks, novelty
// foreground coloring), so that launch pins the engine back to pierre through a
// private config home.
const pierreConfigHomes: string[] = [];

function createPierreEngineConfigHome() {
  const home = mkdtempSync(join(tmpdir(), "hunk-pty-pierre-config-"));
  pierreConfigHomes.push(home);
  mkdirSync(join(home, "hunkt"), { recursive: true });
  writeFileSync(join(home, "hunkt", "config.toml"), 'engine = "pierre"\n');
  return home;
}

/** Give source loading and asynchronous Shiki highlighting enough headroom in CI. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
  for (const home of pierreConfigHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Create a contiguous added TypeScript file large enough to use the highlight worker. */
function createLargeHighlightTestFiles() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-highlight-worker-"));
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const contents = Array.from(
    { length: 8_000 },
    (_, index) => `export const workerLine${index} = ${index};`,
  ).join("\n");
  writeFileSync(before, "");
  writeFileSync(after, `${contents}\n`);
  return { after, before, dir };
}

describe("PTY syntax highlighting", () => {
  test("keeps key input responsive while a large added file highlights", async () => {
    const fixture = createLargeHighlightTestFiles();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--fast", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      // Effects schedule highlighting after the first plain-text paint. Give that queue a turn,
      // then assert the PTY can still deliver navigation while the worker is busy.
      await sleep(25);
      const started = performance.now();
      await session.press("down");
      expect(performance.now() - started).toBeLessThan(500);

      let colored = "";
      for (let iteration = 0; iteration < 200; iteration += 1) {
        await session.waitIdle({ timeout: 50 });
        colored = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        if (colored.includes("export")) {
          break;
        }
      }
      expect(colored).toContain("export");
    } finally {
      session.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("keeps code after a hidden Elixir heredoc opener out of the string token state", async () => {
    const fixture = harness.createElixirHeredocRepoFixture();
    const session = await harness.launchHunk({
      env: { XDG_CONFIG_HOME: createPierreEngineConfigHome() },
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
    });

    try {
      await session.waitForText(/Line five, edited/, { timeout: 15_000 });

      let keywords = "";
      let comments = "";
      for (let iteration = 0; iteration < 200; iteration += 1) {
        await session.waitIdle({ timeout: 50 });
        keywords = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        comments = await session.text({ immediate: true, only: { foreground: "#8b949e" } });
        if (keywords.includes("def") && comments.includes("Line five, edited.")) {
          break;
        }
      }

      expect(keywords).toContain("def");
      expect(comments).toContain("Line five, edited.");
      expect(comments).toContain('"""');
      expect(
        await session.text({ immediate: true, only: { foreground: "#a5d6ff" } }),
      ).not.toContain("def hello");
    } finally {
      session.close();
    }
  });
});
