import { afterEach, describe, expect, test } from "bun:test";
import { formatCliError, HunkUserError, isUserFacingError } from "./errors";
import { HunkExtensionUserError } from "../extension-api/types";

const originalDebug = process.env.HUNKT_DEBUG;

afterEach(() => {
  if (originalDebug === undefined) {
    delete process.env.HUNKT_DEBUG;
  } else {
    process.env.HUNKT_DEBUG = originalDebug;
  }
});

describe("formatCliError", () => {
  test("formats expected user errors with optional details and no stack", () => {
    expect(formatCliError(new HunkUserError("Not in a repo"))).toBe("hunkt: Not in a repo\n");
    expect(formatCliError(new HunkUserError("Invalid ref", ["Try `HEAD~1`."]))).toBe(
      "hunkt: Invalid ref\n\nTry `HEAD~1`.\n",
    );
  });

  test("hides unexpected stacks unless debug output is explicitly enabled", () => {
    const error = new Error("Boom");
    error.stack = "Error: Boom\n    at internal";

    delete process.env.HUNKT_DEBUG;
    expect(formatCliError(error)).toBe("hunkt: Boom\n");

    process.env.HUNKT_DEBUG = "1";
    expect(formatCliError(error)).toBe("Error: Boom\n    at internal\n");
  });

  test("stringifies non-error thrown values", () => {
    expect(formatCliError("plain failure")).toBe("hunkt: plain failure\n");
  });

  test("formats a published extension user error the same way", () => {
    // An extension backend raises the same failure through the published class,
    // and it must reach the user identically — message, blank line, suggestions.
    expect(
      formatCliError(new HunkExtensionUserError("Invalid ref", { suggestions: ["Try `HEAD~1`."] })),
    ).toBe("hunkt: Invalid ref\n\nTry `HEAD~1`.\n");
  });

  test("recognizes the published shape without an instanceof relationship", () => {
    // A JavaScript extension, or one bundling its own copy of the class, only
    // has the name and the field to go on.
    expect(
      formatCliError({ name: "HunkExtensionUserError", message: "No backend", suggestions: [] }),
    ).toBe("hunkt: No backend\n");
    expect(isUserFacingError(new HunkUserError("x"))).toBe(true);
    expect(isUserFacingError(new Error("x"))).toBe(false);
  });
});
