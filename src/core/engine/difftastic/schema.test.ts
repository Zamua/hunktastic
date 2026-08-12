import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDifftasticJson, validateDifftasticFile } from "./schema";

const FIXTURES_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "difftastic",
);

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/** Sample payload accepted by the schema, used as the base for mutations. */
function sampleValue(): Record<string, unknown> {
  return JSON.parse(loadFixture("sample-0.69.0.json")) as Record<string, unknown>;
}

describe("parseDifftasticJson", () => {
  test.each(["sample-0.69.0.json", "deleted-lines-0.69.0.json", "tabs-0.69.0.json"])(
    "accepts the captured fixture %s",
    (name) => {
      const result = parseDifftasticJson(loadFixture(name));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.file.status).toBe("changed");
      expect(result.file.language).toBeString();
      expect(result.file.path).toBeString();
      expect(result.file.aligned_lines).toBeArray();
      expect(result.file.chunks).toBeArray();
    },
  );

  test("invalid JSON text is a typed invalid-json error", () => {
    const result = parseDifftasticJson("difft exploded: not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-json");
    expect(result.error.message).toBeString();
  });

  test("well-formed JSON with the wrong shape is a typed schema-mismatch", () => {
    const result = parseDifftasticJson("[1, 2, 3]");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });
});

describe("validateDifftasticFile", () => {
  test("accepts an unchanged payload without aligned_lines or chunks", () => {
    const result = validateDifftasticFile({
      language: "Text",
      path: "a.txt",
      status: "unchanged",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.aligned_lines).toBeUndefined();
    expect(result.file.chunks).toBeUndefined();
  });

  test("tolerates unknown keys at every level (the schema is unstable)", () => {
    const value = sampleValue();
    value.schema_version = 9;
    value.extra = { nested: true };
    const chunks = value.chunks as Array<Array<Record<string, unknown>>>;
    const entry = chunks[0]?.[0];
    if (entry == null) throw new Error("sample fixture lost its first chunk entry");
    entry.unknown_key = "kept";
    const lhs = entry.lhs as Record<string, unknown>;
    (lhs.changes as Array<Record<string, unknown>>).push({
      start: 0,
      end: 1,
      content: "x",
      highlight: "normal",
      novel_kind: "future-field",
    });
    expect(validateDifftasticFile(value).ok).toBe(true);
  });

  test.each<[string, (value: Record<string, unknown>) => void]>([
    ["missing status", (value) => delete value.status],
    ["missing path", (value) => delete value.path],
    ["mistyped language", (value) => (value.language = 42)],
    ["aligned row with one element", (value) => (value.aligned_lines = [[0]])],
    ["aligned row with a string", (value) => (value.aligned_lines = [["0", 0]])],
    [
      "chunk side with mistyped line_number",
      (value) => (value.chunks = [[{ lhs: { line_number: "2", changes: [] } }]]),
    ],
    [
      "change span missing end",
      (value) =>
        (value.chunks = [
          [{ rhs: { line_number: 0, changes: [{ start: 0, content: "x", highlight: "normal" }] } }],
        ]),
    ],
    [
      "negative line_number",
      (value) => (value.chunks = [[{ lhs: { line_number: -1, changes: [] } }]]),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = sampleValue();
    mutate(value);
    const result = validateDifftasticFile(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  test("rejects non-object payloads", () => {
    for (const value of [null, 3, "changed", []]) {
      expect(validateDifftasticFile(value).ok).toBe(false);
    }
  });
});
