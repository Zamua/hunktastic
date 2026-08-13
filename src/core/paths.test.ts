import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUNDLED_SKILL_NAMES,
  resolveBundledSkillName,
  resolveBundledSkillPath,
  resolveCanonicalPath,
  resolveGlobalConfigPath,
  resolveGlobalExtensionsDir,
  resolveHunkStatePath,
} from "./paths";

function createTempRoot(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("paths", () => {
  test("resolves XDG config and state paths", () => {
    const env = { XDG_CONFIG_HOME: join("/tmp", "xdg-home") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(join("/tmp", "xdg-home", "hunkt", "config.toml"));
    expect(resolveHunkStatePath(env)).toBe(join("/tmp", "xdg-home", "hunkt", "state.json"));
  });

  /** Every user-scoped path sits under `hunkt`, so upstream `hunk` is never shared with. */
  test("keeps every user-scoped path out of the upstream hunk directory", () => {
    const env = { XDG_CONFIG_HOME: join("/tmp", "xdg-home") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(join("/tmp", "xdg-home", "hunkt", "config.toml"));
    expect(resolveHunkStatePath(env)).toBe(join("/tmp", "xdg-home", "hunkt", "state.json"));
    expect(resolveGlobalExtensionsDir(env)).toBe(join("/tmp", "xdg-home", "hunkt", "extensions"));
  });

  test("falls back to HOME for config and state paths", () => {
    const env = { HOME: join("/tmp", "home") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(
      join("/tmp", "home", ".config", "hunkt", "config.toml"),
    );
    expect(resolveHunkStatePath(env)).toBe(join("/tmp", "home", ".config", "hunkt", "state.json"));
  });

  test("falls back to USERPROFILE when HOME is unavailable", () => {
    const env = { USERPROFILE: join("/tmp", "windows-profile") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(
      join("/tmp", "windows-profile", ".config", "hunkt", "config.toml"),
    );
    expect(resolveHunkStatePath(env)).toBe(
      join("/tmp", "windows-profile", ".config", "hunkt", "state.json"),
    );
  });

  test("locates the bundled Hunk review skill from source by default", () => {
    const resolvedPath = resolveBundledSkillPath(undefined, [import.meta.dir]);

    expect(resolvedPath).toEndWith(join("skills", "hunkt-review", "SKILL.md"));
  });

  test("locates every bundled skill from source by name", () => {
    for (const skillName of BUNDLED_SKILL_NAMES) {
      expect(resolveBundledSkillPath(skillName, [import.meta.dir])).toEndWith(
        join("skills", skillName, "SKILL.md"),
      );
    }
  });

  test("resolves bundled skill names and their short aliases", () => {
    expect(resolveBundledSkillName("hunkt-extensions")).toBe("hunkt-extensions");
    expect(resolveBundledSkillName("extensions")).toBe("hunkt-extensions");
    expect(resolveBundledSkillName(" Review ")).toBe("hunkt-review");
    expect(resolveBundledSkillName("launch-video")).toBeUndefined();
    expect(resolveBundledSkillName("")).toBeUndefined();
  });

  test("names the missing skill when one cannot be located", () => {
    const tempRoot = createTempRoot("hunk-skill-missing-");

    try {
      expect(() => resolveBundledSkillPath("hunkt-extensions", [tempRoot])).toThrow(
        "Could not locate the bundled Hunk hunkt-extensions skill.",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("locates a bundled skill through a nested hunkdiff package", () => {
    const tempRoot = createTempRoot("hunk-skill-path-");

    try {
      const nestedPackageRoot = join(tempRoot, "node_modules", "hunkdiff");
      const skillPath = join(nestedPackageRoot, "skills", "hunkt-review", "SKILL.md");
      const fakeBinary = join(tempRoot, "node_modules", "hunkdiff-linux-x64", "bin", "hunkt");

      mkdirSync(dirname(skillPath), { recursive: true });
      mkdirSync(dirname(fakeBinary), { recursive: true });
      writeFileSync(skillPath, "# skill\n");
      writeFileSync(fakeBinary, "binary\n");

      expect(resolveBundledSkillPath("hunkt-review", [fakeBinary])).toBe(skillPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("canonicalizes two spellings of one directory to the same path", () => {
    // Canonicalize with the same resolver the code under test uses: plain
    // realpathSync leaves Windows 8.3 short names (RUNNER~1) in place, which
    // would make the expected values non-canonical on Windows runners.
    const tempRoot = resolveCanonicalPath(createTempRoot("hunk-canonical-path-"));

    try {
      const target = join(tempRoot, "target");
      const link = join(tempRoot, "link");
      mkdirSync(target, { recursive: true });

      try {
        symlinkSync(target, link, "dir");
      } catch {
        // Some Windows environments cannot create symlinks without elevated privileges.
        return;
      }

      // The mismatch this guards against: `resolve` keeps whichever spelling it
      // was handed, so two layers can "resolve" the same directory and disagree.
      expect(resolveCanonicalPath(link)).toBe(target);
      expect(resolveCanonicalPath(join(link, "nested", "missing.txt"))).toBe(
        join(target, "nested", "missing.txt"),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
