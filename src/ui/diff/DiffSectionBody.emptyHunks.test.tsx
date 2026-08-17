import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import type { DiffFile } from "../../core/types";
import { resolveTheme } from "../themes";

const { DiffSectionBody } = await import("./DiffSectionBody");

const theme = resolveTheme("github-dark-default", null);

/** Identical before/after contents parse to a file with zero hunks. */
function createHunklessFile(engine?: DiffFile["engine"]): DiffFile {
  const contents = "export const alpha = 1;\nexport const beta = 2;\n";
  return {
    ...createTestDiffFile({
      before: contents,
      after: contents,
      id: "hunkless",
      path: "hunkless.ts",
    }),
    engine,
  };
}

async function captureFrame(node: ReactNode, width = 80, height = 12) {
  const setup = await testRender(node, { width, height });

  try {
    await act(async () => {
      await setup.renderOnce();
    });

    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("DiffSectionBody hunkless file body", () => {
  test("a difftastic hunkless file renders the no-structural-changes marker row", async () => {
    const file = createHunklessFile("difftastic");
    expect(file.metadata.hunks).toHaveLength(0);

    const frame = await captureFrame(
      <DiffSectionBody
        file={file}
        layout="stack"
        theme={theme}
        width={78}
        selectedHunkIndex={0}
        scrollable={false}
      />,
    );

    expect(frame).toContain("difftastic: no structural changes");
  });

  test("a pierre hunkless file keeps the generic empty-hunk message", async () => {
    const file = createHunklessFile("pierre");
    expect(file.metadata.hunks).toHaveLength(0);

    const frame = await captureFrame(
      <DiffSectionBody
        file={file}
        layout="stack"
        theme={theme}
        width={78}
        selectedHunkIndex={0}
        scrollable={false}
      />,
    );

    expect(frame).not.toContain("difftastic: no structural changes");
    expect(frame).toContain("No textual hunks to render for this file.");
  });
});
