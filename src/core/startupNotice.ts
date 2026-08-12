/** One transient message shown in the footer during app startup. */
export interface StartupNotice {
  key: string;
  message: string;
}

/** Warn when Hunk had to approximate deprecated semantic syntax colors. */
export const LEGACY_CUSTOM_SYNTAX_NOTICE: StartupNotice = {
  key: "deprecated:custom-theme-syntax",
  message:
    "Deprecated [custom_theme.syntax] translated approximately • migrate to [custom_theme.syntax_scopes]",
};

/** Reuse one array identity so unchanged config reloads do not restart the notice queue. */
export const LEGACY_CUSTOM_SYNTAX_NOTICES: readonly StartupNotice[] = [LEGACY_CUSTOM_SYNTAX_NOTICE];

/**
 * Merge config-derived notices with loader-attached notices (e.g. difftastic
 * fallbacks) and session-scoped notices. Both bootstrap sites (initial startup
 * and the AppHost reload path) must build their notice list through this, so
 * neither can drop the loader's contribution. Returns the configured array
 * identity when nothing else contributed, so unchanged reloads do not restart
 * the notice queue.
 */
export function combineBootstrapStartupNotices(
  configuredNotices: readonly StartupNotice[] | undefined,
  loaderNotices: readonly StartupNotice[] | undefined,
  sessionNotices: readonly StartupNotice[] = [],
): readonly StartupNotice[] | undefined {
  const loader = loaderNotices ?? [];
  if (loader.length === 0 && sessionNotices.length === 0) {
    return configuredNotices;
  }

  return [...(configuredNotices ?? []), ...loader, ...sessionNotices];
}
