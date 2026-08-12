{
  config,
  lib,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.programs.hunkt;
  tomlFormat = pkgs.formats.toml { };
in
{
  options.programs.hunkt = {
    enable = mkEnableOption "hunkt, a terminal-first diff viewer";

    package = mkOption {
      type = types.package;
      # No nixpkgs attribute provides hunkt, so this default fails loudly rather
      # than silently installing upstream hunk. The flake module sets it.
      default = pkgs.hunkt;
      defaultText = literalExpression "pkgs.hunkt";
      description = "The hunkt package to use.";
    };

    settings = mkOption {
      type = tomlFormat.type;
      default = { };
      example = literalExpression ''
        {
          theme = "graphite";
          mode = "auto";
          line_numbers = true;
          exclude_untracked = false;
        }
      '';
      description = ''
        Configuration for hunkt, see
        <link xlink:href="https://github.com/modem-dev/hunk#config"/>.
      '';
    };

    enableGitIntegration = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to set hunkt as the default git pager.";
    };

    enableJujutsuIntegration = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to set hunkt as the default jujutsu pager. Also sets ui.diff-formatter to \":git\" so jj emits git-style diffs hunkt can render.";
    };

    enableClaudeIntegration = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to link the hunk-review skill under ~/.claude/skills.";
    };

    installDifftastic = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Whether to install difftastic alongside hunkt. The difftastic engine
        runs `difft` as a subprocess, so without it on PATH that engine falls
        back to line diffs. Disable when difftastic comes from elsewhere.
      '';
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ] ++ lib.optional cfg.installDifftastic pkgs.difftastic;

    xdg.configFile."hunkt/config.toml" = mkIf (cfg.settings != { }) {
      source = tomlFormat.generate "hunkt-config.toml" cfg.settings;
    };

    programs.git.settings.core.pager = mkIf cfg.enableGitIntegration "hunkt pager";

    programs.jujutsu.settings = mkIf cfg.enableJujutsuIntegration {
      ui = {
        diff-formatter = ":git";
        pager = "hunkt pager";
      };
    };

    home.file = mkIf cfg.enableClaudeIntegration {
      ".claude/skills/hunk-review".source = "${cfg.package}/skills/hunk-review";
    };
  };
}
