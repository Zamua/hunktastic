# difftastic engine

Structural diffs (difftastic) as a second, opt-in diff engine under hunk's
review TUI and agent annotation flow. Default engine stays `pierre`.

difftastic is consumed as a subprocess (`difft --display json`, gated by
`DFT_UNSTABLE=yes`). The JSON schema is explicitly unstable. Pin the tested
binary version, validate every payload defensively, and fall back to the
existing Pierre path on any doubt. The engine must never crash the app and
never produce a silently wrong diff: every fallback is visible.

Tested against difftastic 0.69.0. Ground-truth fixture:
`test/fixtures/difftastic/` (see Testing).

## 1. Scope

### v1 in scope

- Structural rendering for the two-file flow (`hunk diff A B`, `difftool`)
  and the git-backed flows (`hunk diff` working tree, `show`, `stash-show`)
  in the review stream.
- `[` / `]` hunk navigation over structural chunks (difftastic chunks become
  `metadata.hunks`; all existing cursor machinery works unchanged).
- Agent comments: `hunk session comment add` with `--hunk/hunkNumber`,
  `--old-line`, `--new-line` anchors resolving against structural hunks.
- Split and stack layouts, including difftastic's explicit lhs/rhs row
  alignment in split view.
- Intraline novelty spans from difftastic's per-line column ranges, rendered
  via the existing emphasis-background span mechanism.

### v1 out of scope (explicit)

- Word-level novelty emphasis PARITY with difftastic's own terminal display.
  The JSON strips display-level novelty emphasis (difftastic issue #658); v1
  renders the token spans the JSON does carry and accepts visual divergence.
- difftastic for `patch` and `pager` inputs (no file contents available;
  Pierre always, one notice if `engine = "difftastic"` is configured).
- Watch-mode performance edge cases. Watch re-runs the full load pipeline;
  if per-file difft spawns make watch sluggish, watch keeps difftastic but a
  content-hash spawn cache is a follow-up, not a v1 blocker.
- npm publishing of any of this.
- Tuning difft limits (`--graph-limit`, `--byte-limit`,
  `--parse-error-limit`). v1 runs difft defaults; difft's internal
  line-oriented fallback output is accepted as-is.

## 2. Engine selection surface

New option `engine`, values `"pierre" | "difftastic"`. Layered exactly like
existing view options. Precedence (low to high): built-in default `pierre`
-> user config TOML -> repo `.hunk/config.toml` -> `HUNK_ENGINE` env ->
`--engine` CLI flag.

Touch list (mirrors the `layout` option shape):

- `src/core/types.ts` — add `engine?: DiffEngineId` to `CommonOptions`;
  export `type DiffEngineId = "pierre" | "difftastic"`.
- `src/core/cli.ts` — add `{ flag: "--engine <engine>" }` to
  `COMMON_REVIEW_OPTIONS` (auto-registers on every `commonReviewOptions`
  command); add `parseEngine` validator next to `parseLayoutMode`
  (closed enum, reject unknown values at parse time); wire in
  `applyReferenceOption`; thread through `buildCommonOptions`; add the flag
  line to the hand-written `renderCliHelp`.
- `src/core/config.ts` — add `CONFIG_REFERENCE_OPTIONS` entry
  (`key: "engine"`, `runtimeDefault: "pierre"`); add an explicit string case
  in `normalizeConfigReferenceValue` (the default branch is
  `normalizeBoolean` and silently drops string keys); add
  `engine: overrides.engine ?? base.engine` to `mergeOptions`; apply
  `HUNK_ENGINE` (validated, invalid value ignored with a notice) in
  `resolveConfiguredCliInput` after the repo layer and before CLI-flag merge;
  final default fill `engine: resolvedOptions.engine ?? "pierre"`.
- `src/core/config.ts` — second key `difft_path` (binary path override).
  Honored from user config and `HUNK_DIFFT_PATH` env only; a repo-config
  value is IGNORED with the existing exec-adjacent repo-config notice
  treatment (`createRepoExtensionConfigNotice` precedent). Default `"difft"`
  (PATH lookup).
- Regenerate docs: `bun run generate:docs`
  (`scripts/generate-docs.test.ts` asserts every runtime key renders).

`HUNK_ENGINE` is the test hook: PTY/CLI tests set it instead of threading
flags. It deliberately sits below the CLI flag so an explicit `--engine`
always wins.

Reloads are covered for free: `performReloadSession` re-runs
`resolveRuntimeCliInput` -> `resolveConfiguredCliInput`, and
`withCurrentViewOptions` preserves `engine` across refresh.

## 3. Subprocess layer

New core module `src/core/engine/difftastic/` (this is a core engine, not an
extension: the extension API has no engine registration surface and VCS
adapters emit patch text that core always parses with Pierre).

- `src/core/engine/difftastic/exec.ts` — spawn wrapper. Copy the
  `runGitCommand` shape (`src/extensions/default/vcs/git/commands.ts`):
  `Bun.spawnSync([difftPath, ...args], { stdin: "ignore", stdout: "pipe",
stderr: "pipe", env, timeout })`, exit-code allowlist `[0]`, spawn-throw
  translated to a typed missing-binary result (match Bun's
  "Executable not found in $PATH").
- Every invocation sets `DFT_UNSTABLE: "yes"` in env.
- Version detection: `difft --version` once per process, cached in module
  state. Parse `Difftastic X.Y.Z`. Unparseable output = missing binary.
  Record the version; no minimum enforced in v1, but the schema validator is
  the real gate (see below).
- Per-file invocation with explicit paths:
  `difft --display json <beforePath> <afterPath>`. No context flag: JSON
  chunks carry only novel lines; context is reconstructed from file bodies.
- Timeout: 5000 ms per file. Timeout or kill -> per-file fallback.
- Input materialization (`materialize.ts`): the two-file flow passes the real
  paths directly. Git-backed flows fetch both sides via the file's
  `sourceFetcher.getFullText("old" | "new")` (`src/core/fileSource.ts`) and
  write them to `<os.tmpdir()>/hunk-difft-<pid>/<n>/{old,new}/<basename>`,
  preserving the basename so difft's extension-based language detection
  works. Delete the tree in `finally`. A `null` fetch or the
  `DEFAULT_SOURCE_TEXT_MAX_BYTES` cap exceeded -> per-file fallback.
- `schema.ts` — zod schema (zod is already a dependency) for the per-file
  object: `{ aligned_lines: [number|null, number|null][], chunks:
ChunkEntry[][], language: string, path: string, status: string }`,
  `ChunkEntry = { lhs?: SideEntry, rhs?: SideEntry }`, `SideEntry =
{ line_number: number, changes: { start: number, end: number,
content: string, highlight: string }[] }`. Unknown top-level keys are
  allowed (schema is unstable); missing/mistyped required keys fail
  validation -> per-file fallback.

### Fallback ladder

| Condition                                                                                                    | Behavior                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary missing / version probe fails                                                                         | Whole changeset renders via Pierre. One startup notice via the existing `bootstrap.startupNotices` mechanism (`src/app/startup.ts:342`, rendered by `AppHost`): `difftastic engine unavailable (difft not found); using pierre`. |
| difft nonzero exit / timeout for a file                                                                      | Pierre for that file.                                                                                                                                                                                                            |
| JSON parse or schema validation failure                                                                      | Pierre for that file.                                                                                                                                                                                                            |
| Mapper validation failure (non-monotonic `aligned_lines`, line numbers out of file bounds, unknown `status`) | Pierre for that file.                                                                                                                                                                                                            |
| Source text unavailable / over size cap                                                                      | Pierre for that file.                                                                                                                                                                                                            |
| Binary file (`DiffFile.isBinary`)                                                                            | Never sent to difft; existing binary rendering.                                                                                                                                                                                  |
| `patch` / `pager` input kind                                                                                 | Pierre always; one notice if difftastic was configured.                                                                                                                                                                          |

Per-file fallbacks are aggregated into one startup notice
(`difftastic fell back to pierre for N file(s)`); details go to `log`
diagnostics, not the UI. `DiffFile` gains `engine: DiffEngineId` so the UI
and the session protocol can report which engine produced each file.

## 4. Engine dispatch point

All computation stays at load time inside `loadAppBootstrap`
(`src/core/loaders.ts`); render never re-diffs.

Difftastic is an OVERLAY on the existing pipeline, not a replacement parser:

1. Run the existing path first. Git-backed modes: git patch text ->
   `normalizePatchChangeset` -> Pierre `parsePatchFiles` -> `buildDiffFile`.
   Two-file mode: `loadFileDiffChangeset` -> Pierre `parseDiffFromFile`.
   This yields the file list, paths, rename detection, binary sniff,
   `DiffFile.patch` chunks, and a complete Pierre metadata to fall back to
   per file.
2. If `engine === "difftastic"`, call
   `applyDifftasticEngine(changeset, opts)`
   (`src/core/engine/difftastic/index.ts`) before `orderDiffFiles`. For each
   eligible file (not binary, not too large, status-eligible) it obtains
   both bodies, runs difft, maps the JSON, and REPLACES
   `file.metadata.hunks` + the flat line arrays (see Mapping), sets
   `file.engine = "difftastic"`, recomputes `file.stats` from the mapped
   hunks (so header counts match rendered rows), and attaches the intraline
   sidecar. Any failure leaves the Pierre metadata untouched and records the
   fallback.
3. Skip difft for `ChangeTypes` `new` / `deleted` files: a pure
   creation/deletion has no structural alignment to compute; Pierre's
   all-addition/all-deletion hunk is already correct.

The two-file flow already holds both bodies in memory
(`loaders.ts` reads them for `parseDiffFromFile`); pass them straight to the
mapper without re-reading. Git-backed flows use the per-file
`sourceFetcher`, which is attached by `buildDiffFile` before the overlay
runs.

## 5. Mapping layer: difftastic JSON -> Pierre model

Module `src/core/engine/difftastic/map.ts`. Pure function:

```
mapDifftasticFile(json, oldText, newText, options) -> {
  hunks: Hunk[],
  deletionLines: string[],   // full old file
  additionLines: string[],   // full new file
  noveltySpans: DiffLineNoveltySpans,
  changeType: ChangeTypes,
} | { fallback: reason }
```

### 5.1 Ground truth from the sample (difftastic 0.69.0)

Fixture: `DFT_UNSTABLE=yes difft --display json before.js after.js`.
Two facts the mapper MUST honor (both are traps for a chunks-only reader):

- An added/deleted line with no novel token content (e.g. an inserted blank
  line) appears in `aligned_lines` as `[null, n]` / `[n, null]` but has NO
  chunk entry at all (sample: rhs line 7). Novelty by position must be
  derived from `aligned_lines`, not from `chunks`.
- A chunk entry can list a side with an EMPTY `changes` array (sample: lhs
  line 0, paired with a rhs line that gained tokens). The line pair is still
  a modification; the empty side simply has zero novel spans.

`highlight` on a change span is a syntax kind
(`normal|string|keyword|type|comment|delimiter|tree_sitter_error`), not
novelty emphasis. Every span listed in `changes` IS novel (only novel spans
are emitted); `highlight` is ignored by the mapper (Shiki already owns
syntax color). `start`/`end` are 0-based, end-exclusive UTF-8 BYTE offsets
into the line, not string indexes (the unicode fixture pins this: an ASCII
token after Japanese text reports byte columns [35,38] where the JS string
index is [21,24]). The mapper remaps each offset to a UTF-16 code-unit
offset by walking the line's code points; an offset that does not land on a
code-point boundary routes the file to the Pierre fallback
(`invalid-span`), like every other validation failure.

None of the four architecture reports contradicts the sample. The reports do
not describe the difftastic JSON at all; the two traps above are documented
here because no report covers them.

### 5.2 Row classification over `aligned_lines`

`aligned_lines` covers the whole file as ordered `[lhs|null, rhs|null]`
rows, 0-based. Validate monotonicity: non-null values on each side must be
strictly increasing, and every 0..len-1 line of each file must appear
exactly once (fallback otherwise).

Build a novelty index from `chunks`: `(side, line_number) -> spans[]`.
Classify each aligned row:

- `[n, null]` -> deletion row (novel even without a chunk entry).
- `[null, m]` -> addition row (novel even without a chunk entry).
- `[n, m]` where either side has a chunk entry with nonempty `changes` ->
  modified pair (maps to one deletion + one addition, explicitly paired).
- `[n, m]` otherwise -> context row. Defensive check: old line n text must
  equal new line m text; mismatch -> fallback (would indicate a chunk entry
  the schema missed).

A chunk entry where BOTH sides have empty `changes` (not observed; possible
under the unstable schema) classifies as context.

### 5.3 Index conventions

- difftastic `line_number` and `aligned_lines` values: 0-based file lines.
- Pierre `additionStart` / `deletionStart`: 1-based (= difftastic value +1).
- Pierre `additionLineIndex` / `deletionLineIndex`: 0-based indexes into the
  flat arrays. The mapper emits FULL files into
  `deletionLines` / `additionLines` and sets `isPartial: false`
  (Pierre's generated-from-contents convention), so LineIndex fields equal
  the 0-based file line numbers directly. No offset bookkeeping.
- `isPartial: false` also means the source-backed highlight plan (which is
  unified-diff-shaped and would reject difftastic hunks) never runs; full
  Shiki highlighting happens directly, and collapsed-gap expansion reads
  real file lines.

### 5.4 Hunk boundaries = difftastic chunks, context-merged

One difftastic chunk = one candidate hunk. For each chunk, take the min/max
aligned-row indexes touched by its entries, then extend by `context = 3`
aligned rows in each direction (clamped to the file). Merge candidates whose
extended row spans overlap or touch; each merged span becomes one `Hunk`.
This mirrors Pierre `parseDiffFromFile({ context: 3 })` merge behavior, so
`[` / `]` navigation density matches what users get from the Pierre engine.
Chunk order in the JSON is array order; hunks inherit it (no stable IDs
exist upstream; see Follow-ups).

Per hunk, walk its aligned-row span and emit `hunkContent` as maximal
homogeneous runs:

- context rows -> `ContextContent { type: "context", lines: k,
additionLineIndex, deletionLineIndex }` (both sides advance together;
  the old/new numbers may differ by a constant offset, which the render
  counters reproduce naturally).
- consecutive deletion rows -> `ChangeContent { deletions: k, additions: 0 }`.
- consecutive addition rows -> `ChangeContent { deletions: 0, additions: k }`.
- consecutive modified pairs -> `ChangeContent { deletions: k, additions: k }`.

The homogeneous-run rule is what carries difftastic's alignment into the
split layout: `buildSplitRows` pairs deletion i with addition i positionally
inside a change block, and inside a modified-pair run positional pairing IS
the difftastic alignment. A mixed run (del, pair, add) becomes three
adjacent blocks, so unpaired lines render against empty cells exactly as
difftastic aligns them. The row builders walk `hunkContent` entries without
assuming context/change alternation, so adjacent `ChangeContent` blocks are
legal. Stack layout consumes the same blocks (deletions then additions per
block), which interleaves modified pairs more tightly than git-style
all-dels-then-all-adds; that is intended.

Hunk numeric fields:

- `deletionStart` / `additionStart`: first row's 1-based line per side (for
  a side with no lines in the hunk, the running counter value, matching
  unified-diff convention).
- `deletionCount` / `additionCount`: per-side line counts including context
  (these feed `hunkLineRange`, so comment anchoring on context lines keeps
  working).
- `deletionLines` / `additionLines` (per-hunk counts): changed lines only.
- `collapsedBefore`: aligned rows between this hunk's span start and the
  previous hunk's span end (first hunk: rows before its span). Collapsed
  regions are context-only by construction, so `expandCollapsedRows`'s
  1:1 both-sides advance holds, and the trailing-gap
  `additionRemaining === deletionRemaining` invariant holds.
- `splitLineStart/Count`, `unifiedLineStart/Count`: cumulative render-row
  counts computed the same way Pierre does (split rows = context +
  max(d, a) per block; unified rows = context + d + a).
- `noEOFCRDeletions` / `noEOFCRAdditions`: from missing trailing newline in
  the respective body.
- `hunkContext`: leave undefined in v1 (`formatHunkHeader` computes
  `@@ -a,b +c,d @@` from the numeric fields).

### 5.5 Intraline novelty spans

The render path today carries intraline emphasis only as Pierre HAST
decorations (`data-diff-span`) flattened into emphasis-background
`RenderSpan`s; no numeric columns survive. difftastic gives numeric columns.
Bridge with the established sidecar precedent (`DiffLineMoveKinds`):

- New `DiffFile.noveltySpans?: DiffLineNoveltySpans` in
  `src/core/types.ts`: `{ additionLines: (ColumnSpan[] | undefined)[],
deletionLines: (ColumnSpan[] | undefined)[] }`, index-aligned with the
  flat metadata arrays, `ColumnSpan = [start, end]` 0-based end-exclusive
  UTF-16 code-unit offsets, remapped by the mapper from the UTF-8 byte
  offsets in `changes[].start/end` (section 5.1). Sparse: only novel lines
  have entries; a modified line with empty `changes` gets `[]` (novel line,
  no emphasis).
- Render: in `src/ui/diff/pierre.ts`, where cells are built (the same sites
  that consult `lineMoveKinds`), apply
  `overlayNoveltySpans(spans, columnSpans, emphasisBg)`: split the flattened
  `RenderSpan[]` at the column boundaries and set the emphasis `bg`
  (reuse `wordDiffHighlightBg`). The renderer receives code-unit spans (the
  mapper already remapped the byte offsets), so they slice line text and
  `RenderSpan.text` directly.
- For difftastic-engine files, pass Pierre `lineDiffType: "none"`
  (supported: `LineDiffTypes = 'word-alt' | 'word' | 'char' | 'none'`) so
  Pierre's own word-diff decorations do not double-highlight. Make
  `pierreRenderOptions` per-file instead of module-const.

### 5.6 File status handling

| difftastic `status`                     | Mapping                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changed`                               | Full mapping as above. `ChangeTypes: "change"` (or the Pierre metadata's existing rename type, preserved from the baseline parse).                                                                                                                                                                                                                                                                         |
| `unchanged`                             | Structurally identical (difftastic may report this for changes it considers non-semantic even when git reported a textual diff). Keep the file with `hunks: []`, stats 0/0, and a per-file "no structural changes" marker rendered where an empty-hunk file renders today (mode-only changes already produce hunkless files). Verify `DiffPane`/geometry handle the hunkless case in the integration test. |
| `created` / `deleted`                   | Not reached in practice (dispatch skips `new`/`deleted` files, section 4). If difft reports it anyway for a `change`-typed file, treat as mapper validation failure -> Pierre fallback.                                                                                                                                                                                                                    |
| anything else (incl. any binary marker) | Fallback for the file.                                                                                                                                                                                                                                                                                                                                                                                     |

Renames: difftastic is invoked on the materialized old/new bodies; rename
bookkeeping (`previousPath`, `ChangeTypes` rename variants) stays with the
baseline Pierre/git parse and is not touched by the overlay.

## 6. Annotation semantics across engines

Anchor model recap: annotations are line-range based (`oldRange` /
`newRange`, 1-based inclusive); `hunkIndex` on `LiveComment` is frozen at
creation. Resolution paths: `findHunkIndexForLine` (line -> hunk via
`hunkLineRange`) and direct `hunkIndex` bounds-check, both against
`file.metadata.hunks`.

Rules:

- **Line anchors (`--old-line` / `--new-line`, `oldRange`/`newRange`) are
  engine-independent.** They are real 1-based file line numbers; difftastic
  hunks carry real per-side starts/counts, so `hunkLineRange` and
  `findHunkIndexForLine` resolve them against either engine unchanged. A
  line inside a difftastic hunk's context window anchors to that hunk; a
  line no hunk covers gets the existing "No {side} diff hunk covers line"
  error (difftastic hunks can cover fewer lines than Pierre's when difft
  suppresses non-semantic changes; that error is correct, not a bug).
- **Hunk-number anchors (`--hunk N` / `hunkNumber`) are engine-RELATIVE.**
  N resolves against the currently active engine's `file.metadata.hunks`,
  1-based at the CLI, converted once at the broker
  (`brokerServer.ts`: `hunkIndex = hunkNumber - 1`), exactly as today. No
  cross-engine translation table is built. The contract that makes this
  safe: `hunk session review --json` summarizes the SAME array
  (`summarizeHunk` over `file.metadata.hunks`), so an agent that plans
  `--hunk N` from `review --json` output within a session always targets
  what it saw.
- `session review --json` additions (`src/session/types.ts`): per-file
  `engine: "pierre" | "difftastic"` (per-file because fallback is per-file)
  and a top-level `engine` echoing the configured engine. Document in
  `skills/` + agent-facing help: **agents should prefer line anchors**;
  hunk numbers are valid only against the engine/hunk list reported by the
  same session's `review --json`.
- Persisted/sidecar annotations (`--agent-context`) contain only line
  ranges, never hunk indexes; they re-anchor cleanly under either engine via
  the existing range-overlap machinery (`annotationOverlapsHunk`,
  `annotationAnchor`). The frozen `LiveComment.hunkIndex` remains advisory
  display state, as today; switching engines between sessions re-resolves
  placement from ranges.
- Inline note placement (`buildReviewRenderPlan`) matches anchor rows by
  side + line number, which difftastic rows carry; no change needed.

## 7. Testing plan

Fixtures (committed, so tests never need the difft binary):

- `test/fixtures/difftastic/before.js`
- `test/fixtures/difftastic/after.js`
- `test/fixtures/difftastic/sample-0.69.0.json` (captured output, verbatim)
- `test/fixtures/difftastic/unicode-{before,after}.js` +
  `unicode-0.69.0.json` (multibyte line; pins the byte-offset ground truth
  of section 5.1)
- plus small synthetic JSON fixtures for edge cases the pair does not
  exercise (mixed del/pair/add run, added blank line, `unchanged` status,
  non-monotonic `aligned_lines`, schema violations).

Unit tests (colocated `*.test.ts`, repo convention):

- `src/core/engine/difftastic/map.test.ts` — the heart:
  - sample JSON + bodies -> exact `Hunk[]` (starts, counts, `hunkContent`
    runs, `collapsedBefore`, split/unified line counts).
  - blank-line addition (aligned-only, no chunk entry) becomes an addition
    row.
  - empty-`changes` side of a modified pair -> deletion row with `[]`
    novelty spans.
  - chunk merge: two chunks within 2x context rows -> one hunk; far apart ->
    two hunks with correct `collapsedBefore`.
  - context reconstruction equals file bodies; mismatch -> fallback result.
  - monotonicity/bounds violations -> fallback result, never throw.
  - `unchanged` status -> empty hunks; unknown status -> fallback.
  - noveltySpans arrays index-align with the flat line arrays.
- `src/core/engine/difftastic/schema.test.ts` — accepts the captured
  sample; rejects the synthetic malformed payloads; tolerates unknown extra
  keys.
- `src/core/engine/difftastic/exec.test.ts` — missing binary translated to
  the typed result (point `difft_path` at a nonexistent path); nonzero exit
  and timeout paths via a stub script fixture.
- `src/core/cli.test.ts` / `src/core/config.test.ts` additions — flag
  parsing (rejects unknown engine), TOML key + per-command section layering,
  `HUNK_ENGINE` precedence below `--engine`, `difft_path` ignored from repo
  config with notice.
- `src/ui/diff/pierre.test.ts` addition — `overlayNoveltySpans` splits
  spans at column boundaries and preserves text.

Integration (one PTY case, only because it is cheap):

- `test/cli/engineDifftastic.test.ts` — skipped unless `difft` is on PATH.
  Runs `hunk diff before.js after.js --engine difftastic` against the
  committed fixture pair, asserts the structural hunk renders and that
  `session review --json` reports `engine: "difftastic"`. A second
  non-skipped case runs with `difft_path` pointed at a nonexistent binary
  and asserts the one-line fallback notice + Pierre rendering (the fallback
  ladder is testable without difftastic installed).

Docs: `bun run generate:docs` after the config table change;
`scripts/generate-docs.test.ts` enforces coverage.

## 8. Follow-ups

- **Upstream difftastic asks** (Wilfred solicits JSON-consumer feedback in
  issues #216 / #916): stable hunk/chunk IDs in the JSON (today only array
  order exists, which blocks durable hunk anchors); word-level novelty
  emphasis in the JSON (issue #658) so v1's "parity out of scope" caveat can
  close; a schema version field so consumers can gate on payload shape
  instead of binary version.
- **Nix packaging**: add `difftastic` to `flake.nix` devShell so
  contributors get the pinned tested version; consider an optional wrapper
  that bakes `difft_path` for nix-installed hunk.
- **herdr split-screen live-annotation demo**: hunk review TUI with
  `engine = "difftastic"` in one pane, an agent adding structural-hunk
  comments over `hunk session comment add` in the other.
- Watch-mode spawn cache keyed by (old content hash, new content hash) if
  per-file difft spawns measurably slow reloads.
- Consider difftastic for `patch`/`pager` inputs by reconstructing bodies
  from the patch when `isPartial` context suffices (needs design; excluded
  from v1).
