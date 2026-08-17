---
name: hunkt-review
description: Interacts with live Hunk diff review sessions via CLI. Inspects review focus, navigates files, hunks, and exact lines, reloads session contents, adds inline review comments, and paints attention marks on character ranges. Use when the user has a Hunk session running or wants to review diffs interactively.
---

# Hunk Review

Hunk is an interactive terminal diff viewer. The TUI is for the user -- do NOT run `hunkt diff`, `hunkt show`, or other interactive commands directly. Use `hunkt session *` CLI commands to inspect and control live sessions through the local daemon.

If no session exists, ask the user to launch Hunk in their terminal first.

## Workflow

```text
1. hunkt session list                                    # find live sessions
2. hunkt session get --repo .                            # inspect path / repo / source
3. hunkt session review --repo . --json                  # inspect file/hunk structure first
4. hunkt session review --repo . --include-patch --json  # opt into raw diff text only when needed
5. hunkt session context --repo .                        # check current focus when needed
6. hunkt session navigate ...                            # move to the right place
7. hunkt session reload -- <command>                     # swap contents if needed
8. hunkt session comment add ...                         # leave one review note
9. hunkt session comment apply ...                       # apply many agent notes in one stdin batch
10. hunkt session highlight add ...                      # light up the exact range you are explaining
```

## Session selection

Most session commands accept:

- `--repo <path>` -- match the live session by its current loaded repo root (most common)
- `<session-id>` -- match by exact ID (use when multiple sessions share a repo)
- If only one session exists, it auto-resolves

`reload` also supports:

- `--session-path <path>` -- match the live Hunk window by its current working directory
- `--source <path>` -- load the replacement `diff` / `show` command from a different directory

Use `--source` only for advanced reloads where the live session you want to control is not already associated with the checkout you want to load next. For a normal worktree session, prefer selecting it directly with `--repo /path/to/worktree`.

## Commands

### Inspect

```bash
hunkt session list [--json]
hunkt session get (<session-id> | --repo <path>) [--json]
hunkt session context (<session-id> | --repo <path>) [--json]
hunkt session review (<session-id> | --repo <path>) [--include-patch] [--include-notes] [--json]
```

- `get` shows the session `Path`, `Repo`, and `Source`, which helps when choosing between `--repo` and `--session-path`
- `Repo` is what `--repo` matches; `Path` is what `--session-path` matches
- `review --json` returns file and hunk structure by default; add `--include-patch` only when a caller truly needs raw unified diff text
- `review --include-notes` also returns the live review notes alongside the file and hunk structure

### Navigate

```bash
hunkt session navigate (<session-id> | --repo <path>) --file <path> (--hunk <n> | --old-line <n> | --new-line <n>) [--json]
hunkt session navigate (<session-id> | --repo <path>) (--next-comment | --prev-comment) [--json]
```

Absolute navigation requires `--file` and exactly one of `--hunk`, `--new-line`, or `--old-line`:

```bash
hunkt session navigate --repo . --file src/App.tsx --hunk 2
hunkt session navigate --repo . --file src/App.tsx --new-line 372
hunkt session navigate --repo . --file src/App.tsx --old-line 355
```

Relative comment navigation jumps between annotated hunks and does not require `--file`:

```bash
hunkt session navigate --repo . --next-comment
hunkt session navigate --repo . --prev-comment
```

- `--hunk <n>` is 1-based
- `--new-line` / `--old-line` are 1-based line numbers on that diff side
- A line target lands the user's viewport on that exact line (falling back to its hunk when the line is inside a collapsed region); `--hunk` lands on the hunk
- Use either `--next-comment` or `--prev-comment`, not both

### Reload

Swaps the live session's contents. Pass a Hunk review command after `--`:

```bash
hunkt session reload (<session-id> | --repo <path> | --session-path <path>) [--source <path>] [--json] -- diff [ref] [-- <pathspec...>]
hunkt session reload (<session-id> | --repo <path> | --session-path <path>) [--source <path>] [--json] -- show [ref] [-- <pathspec...>]
```

Examples:

```bash
hunkt session reload --repo . -- diff
hunkt session reload --repo . -- diff main...feature -- src/ui
hunkt session reload --repo . -- show HEAD~1
hunkt session reload --repo . -- show HEAD~1 -- README.md
hunkt session reload --repo /path/to/worktree -- diff
hunkt session reload --session-path /path/to/live-window --source /path/to/other-checkout -- diff
```

- Always include `--` before the nested Hunk command
- `--repo` or `<session-id>` usually selects the session you want
- `--source` is advanced: it does not select the session; it only changes where the replacement review command runs
- If the live session is already showing the target worktree, prefer `hunkt session reload --repo /path/to/worktree -- diff`
- `--session-path` targets the live window when you need to keep session selection separate from reload source

### Comments

```bash
hunkt session comment add (<session-id> | --repo <path>) --file <path> (--old-line <n> | --new-line <n>) --summary <text> [--rationale <text>] [--author <name>] [--markup <stml>] [--focus] [--json]
hunkt session comment apply (<session-id> | --repo <path>) --stdin [--focus] [--json]
hunkt session comment list (<session-id> | --repo <path>) [--file <path>] [--type <live|all|ai|agent|user>] [--json]
hunkt session comment rm (<session-id> | --repo <path>) <comment-id> [--json]
hunkt session comment clear (<session-id> | --repo <path>) [--file <path>] [--include-user|--all] --yes [--json]
```

Examples:

```bash
hunkt session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"
printf '%s\n' '{"comments":[{"filePath":"README.md","newLine":103,"summary":"Tighten this wording"}]}' | hunkt session comment apply --repo . --stdin
```

- `comment list --type user` shows human-authored inline notes; without `--type`, `comment list` preserves the legacy live-agent-comment view
- `comment add` is best for one note; `comment apply` is best when an agent already has several notes ready
- `comment add` requires `--file`, `--summary`, and exactly one of `--old-line` or `--new-line`
- `comment apply` payload items require `filePath`, `summary`, and exactly one target such as `hunk`, `hunkNumber`, `oldLine`, or `newLine`
- `comment apply` reads a JSON batch from stdin and validates the full batch before mutating the live session
- Pass `--focus` when you want to jump to the new note or the first note in a batch
- `comment list` and `comment clear` accept optional `--file`
- Quote `--summary` and `--rationale` defensively in the shell

### Attention marks

Highlights paint character ranges inside the diff lines the user is looking at — use them to light up the exact expression you are explaining while you narrate.

```bash
hunkt session highlight add (<session-id> | --repo <path>) --file <path> (--old-line <n> | --new-line <n>) --start <n> --end <n> [--tone <tone>] [--focus] [--json]
hunkt session highlight clear (<session-id> | --repo <path>) [--file <path>] [--json]
```

Examples:

```bash
hunkt session highlight add --repo . --file src/App.tsx --new-line 42 --start 6 --end 19
hunkt session highlight add --repo . --file src/App.tsx --new-line 42 --start 6 --end 19 --tone warning --focus
hunkt session highlight clear --repo .
```

- `highlight add` requires `--file`, exactly one of `--old-line` or `--new-line`, and the `--start` / `--end` offsets
- `--start` is a 0-based inclusive offset into the line's text and `--end` is exclusive, counted in UTF-16 code units — the same `[start, end)` range extensions use
- Tones: `match` (default), `info`, `warning`, `error`; `current` renders as reverse video and is best reserved for the one range under discussion
- Pass `--focus` to also land the viewport on the marked line
- Marks survive scrolling, navigation, and reloads that leave the marked file's content unchanged; a reload that changes that file drops its marks, and `highlight clear` removes them explicitly (optionally per `--file`)
- Marks are visual only — pair them with a `comment add` when the explanation should persist as a note

### Experimental rich markup notes (STML)

Only use STML when `hunkt session context --json` lists `stml` in `experimentalFeatures`. The user opts into that experience by launching the review with `--experimental`; do not ask a normal session to render markup.

For an opted-in session, `--markup` (or a `markup` field on apply items) renders the note body as STML — a small HTML-like markup for terminal UI (boxes, rows, gauges, badges, lists, code). Keep `--summary` a real sentence: it is the fallback and the `comment list` text.

Before writing markup, run `hunkt markup guide` once — it has copy-paste patterns and the width rules. The session context also reports `noteMarkupWidth` (the live render width); preview with `hunkt markup render - --width <that>`. Comment responses echo `markupWidth` and return `markupNotes` when markup degraded — fix what they flag.

## New files in working-tree reviews

`hunkt diff` includes untracked files by default. If the user wants tracked changes only, reload with `--exclude-untracked`:

```bash
hunkt session reload --repo . -- diff --exclude-untracked
```

## Guiding a review

The user may ask you to walk them through a changeset or review code using Hunk. Start with `hunkt session review --json` to understand the file/hunk structure without inflating agent context, then use `--include-patch` only for the files you truly need to read in raw diff form. Use `context` and `navigate` to line up the user's current view before adding comments.

Your role is to narrate: steer the user's view to what matters and leave comments that explain what they're looking at.

Typical flow:

1. Load the right content (`reload` if needed)
2. Navigate to the first interesting file / hunk
3. Add a comment explaining what's happening and why
4. If you already have several notes ready, prefer one `comment apply` batch over many separate shell invocations
5. Summarize when done

Guidelines:

- Work in the order that tells the clearest story, not necessarily file order
- Navigate before commenting so the user sees the code you're discussing
- Use `highlight add --focus` to steer the user's eyes to the exact expression while you explain it, and `highlight clear` before moving to the next topic
- Use `comment apply` for agent-generated batches and `comment add` for one-off notes
- Use `--focus` sparingly when the note itself should actively steer the review
- Keep comments focused: intent, structure, risks, or follow-ups
- Don't comment on every hunk -- highlight what the user wouldn't spot themselves

## Common errors

- **"No diff file matches ..."** -- the file is not in the loaded review. Check `context`, then `reload` if needed.
- **"No active Hunk sessions"** -- if Hunk is visibly running, localhost may be blocked by the agent sandbox; retry with network/sandbox escalation. Otherwise ask the user to open Hunk.
- **"Multiple active sessions match"** -- pass `<session-id>` explicitly.
- **"No active session matches session path ..."** -- for advanced split-path reloads, verify the live window `Path` via `hunkt session get` or `list`, then use `--session-path`.
- **"Pass the replacement Hunk command after `--`"** -- include `--` before the nested `diff` / `show` command.
- **"Pass --stdin to read batch comments from stdin JSON."** -- `comment apply` only reads its batch payload from stdin.
- **"Specify exactly one navigation target"** -- pick one of `--hunk`, `--old-line`, or `--new-line`.
- **"Specify exactly one comment target"** -- pass `comment add` one of `--old-line` or `--new-line`.
- **"Specify exactly one highlight target"** -- pass `highlight add` one of `--old-line` or `--new-line`.
- **"Highlight --end must be greater than --start"** -- offsets are `[start, end)` UTF-16 code units into the line text; end is exclusive.
- **"Specify either --next-comment or --prev-comment, not both."** -- choose one comment-navigation direction.
- **"Could not read the raw diff for ..."** -- the session reloaded or closed while `--include-patch` was reading it. Re-run `review`; drop `--include-patch` if you only need file and hunk structure.
