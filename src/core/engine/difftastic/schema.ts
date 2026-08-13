import { z } from "zod";

/**
 * Defensive validation for `difft --display json` payloads (difftastic 0.69.0,
 * `DFT_UNSTABLE=yes`). The upstream schema is explicitly unstable, so objects
 * are loose: unknown keys pass through, while missing or mistyped required
 * keys fail validation and route the file to the Pierre fallback.
 */

/** One novel token range within a line; columns are 0-based, end-exclusive string indexes. */
const changeSpanSchema = z.looseObject({
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
  content: z.string(),
  // Syntax kind, not novelty emphasis. Shiki owns syntax color, so the mapper
  // reads it only to group spans into atoms and to scope the changed-word tier.
  highlight: z.string(),
});

/** One side of a chunk entry: a 0-based file line plus its novel token spans. */
const sideEntrySchema = z.looseObject({
  line_number: z.int().nonnegative(),
  changes: z.array(changeSpanSchema),
});

/** One aligned lhs/rhs line pair; either side may be present or absent. */
const chunkEntrySchema = z.looseObject({
  lhs: sideEntrySchema.optional(),
  rhs: sideEntrySchema.optional(),
});

/** One whole-file alignment row: `[lhs line | null, rhs line | null]`, 0-based. */
const alignedRowSchema = z.tuple([
  z.int().nonnegative().nullable(),
  z.int().nonnegative().nullable(),
]);

/**
 * One per-file difftastic result. `aligned_lines` / `chunks` are absent for
 * `status: "unchanged"` payloads; the mapper enforces their presence for
 * `status: "changed"`.
 */
const difftasticFileSchema = z.looseObject({
  aligned_lines: z.array(alignedRowSchema).optional(),
  chunks: z.array(z.array(chunkEntrySchema)).optional(),
  language: z.string(),
  path: z.string(),
  status: z.string(),
});

export type DifftasticChangeSpan = z.infer<typeof changeSpanSchema>;
export type DifftasticSideEntry = z.infer<typeof sideEntrySchema>;
export type DifftasticChunkEntry = z.infer<typeof chunkEntrySchema>;
export type DifftasticAlignedRow = z.infer<typeof alignedRowSchema>;
export type DifftasticFile = z.infer<typeof difftasticFileSchema>;

/** Typed rejection: bad JSON text vs a JSON value the schema does not accept. */
export interface DifftasticSchemaError {
  kind: "invalid-json" | "schema-mismatch";
  message: string;
}

export type DifftasticParseResult =
  | { ok: true; file: DifftasticFile }
  | { ok: false; error: DifftasticSchemaError };

/** Validate an already-parsed JSON value as a difftastic per-file payload. */
export function validateDifftasticFile(value: unknown): DifftasticParseResult {
  const parsed = difftasticFileSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: "schema-mismatch", message: parsed.error.message },
    };
  }
  return { ok: true, file: parsed.data };
}

/** Parse raw `difft --display json` stdout for one file pair. */
export function parseDifftasticJson(text: string): DifftasticParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "invalid-json",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return validateDifftasticFile(value);
}
