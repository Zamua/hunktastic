import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { VcsCatalog } from "./vcs/types";

/** Return whether one path is a `.hunkt` project directory, following directory symlinks. */
function isHunkProjectDirectory(path: string) {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Find the nearest project root established by `.hunkt` or a registered VCS adapter. */
export function findProjectRootCandidate(
  cwd: string,
  catalog?: Pick<VcsCatalog, "adapters">,
): string | undefined {
  let current = resolve(cwd);

  for (;;) {
    if (
      isHunkProjectDirectory(join(current, ".hunkt")) ||
      (catalog?.adapters ?? []).some((adapter) => {
        try {
          return adapter.detect(current)?.repoRoot === current;
        } catch {
          return false;
        }
      })
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
