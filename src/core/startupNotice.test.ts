import { describe, expect, test } from "bun:test";
import { combineBootstrapStartupNotices, type StartupNotice } from "./startupNotice";

const configuredNotice: StartupNotice = { key: "config:example", message: "config notice" };
const loaderNotice: StartupNotice = {
  key: "difftastic:binary-missing",
  message: "difftastic engine unavailable (difft not found); using pierre",
};
const sessionNotice: StartupNotice = { key: "vcs:unknown", message: "unknown vcs" };

describe("combineBootstrapStartupNotices", () => {
  test("loader-attached notices survive alongside configured and session notices", () => {
    expect(
      combineBootstrapStartupNotices([configuredNotice], [loaderNotice], [sessionNotice]),
    ).toEqual([configuredNotice, loaderNotice, sessionNotice]);
  });

  test("loader notices survive when there are no session notices", () => {
    expect(combineBootstrapStartupNotices([configuredNotice], [loaderNotice])).toEqual([
      configuredNotice,
      loaderNotice,
    ]);
  });

  test("loader notices survive without configured notices", () => {
    expect(combineBootstrapStartupNotices(undefined, [loaderNotice])).toEqual([loaderNotice]);
  });

  test("keeps the configured array identity when nothing else contributed", () => {
    const configured = [configuredNotice];
    expect(combineBootstrapStartupNotices(configured, [], [])).toBe(configured);
    expect(combineBootstrapStartupNotices(configured, undefined)).toBe(configured);
    expect(combineBootstrapStartupNotices(undefined, undefined)).toBeUndefined();
  });
});
