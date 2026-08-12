---
title: Live session control
description: Inspect, target, navigate, and reload Hunk windows through the local session broker.
---

Each normal Hunk TUI registers with one loopback daemon. `hunkt session ...` finds a registered window and sends it review actions.

## Find the session

```bash
hunkt session list
hunkt session get --repo .
hunkt session context --repo .
```

Use `--repo <path>` for normal worktrees. Use an explicit session ID when multiple windows share a repository.

## Inspect without overloading context

```bash
hunkt session review --repo . --json
```

This returns files and hunks. Add flags only when required:

```bash
hunkt session review --repo . --include-notes --json
hunkt session review --repo . --include-patch --json
```

## Navigate the visible window

```bash
hunkt session navigate --repo . --file src/App.tsx --hunk 2
hunkt session navigate --repo . --file src/App.tsx --new-line 372
hunkt session navigate --repo . --next-comment
```

Hunk numbers are 1-based. Absolute navigation needs a file and exactly one hunk, old-line, or new-line target.

## Reload the review

Always place `--` before the nested Hunk command:

```bash
hunkt session reload --repo . -- diff
hunkt session reload --repo . -- show HEAD~1 -- README.md
```

Advanced reloads can target the live window by `--session-path` and load from a separate `--source` directory. Prefer `--repo` until those roles genuinely need to differ.

## Diagnose local access

If a visible Hunk window does not appear in `session list`, an agent sandbox may block loopback access. Hunk's daemon is intentionally local-only; retry with the agent's network/sandbox permission rather than exposing it remotely. `hunkt daemon serve` is available for manual startup or daemon debugging.
