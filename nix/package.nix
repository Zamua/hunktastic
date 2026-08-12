{
  bun,
  bun2nix,
  difftastic,
  lib,
  makeWrapper,
  ...
}: let
  packageJson = lib.importJSON ../package.json;
in
  bun2nix.mkDerivation {
    pname = "hunkdiff";
    version = packageJson.version;

    src = ../.;

    bunDeps = bun2nix.fetchBunDeps {
      bunNix = ./bun.lock.nix;
    };

    nativeBuildInputs = [makeWrapper];

    buildPhase = ''
      runHook preBuild
      mkdir -p .bun-tmp .bun-install
      BUN_TMPDIR=$PWD/.bun-tmp \
      BUN_INSTALL=$PWD/.bun-install \
      ${bun}/bin/bun build --compile \
        --no-compile-autoload-bunfig \
        "./src/main.tsx" \
        --outfile "hunk-bin"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp -p ./hunk-bin $out/bin/hunk
      # The npm package exposes both names, and lib.getExe resolves the pname
      # (hunkdiff) because the bun2nix builder does not carry meta.mainProgram
      # through, so a consumer following that path lands here rather than on a
      # missing file.
      ln -s hunk $out/bin/hunkdiff
      cp -r ./skills $out/
      # difftastic ships no library, only a CLI, so the difftastic engine
      # shells out to `difft`. Baking it into the wrapper's PATH keeps the
      # engine working without a second install. It takes precedence over a
      # system difft because difft's JSON output is explicitly unstable and
      # this is the version the engine is tested against; the difft_path
      # setting still overrides it.
      wrapProgram $out/bin/hunk \
        --set HUNK_INSTALL_SOURCE nix \
        --prefix PATH : ${lib.makeBinPath [difftastic]}
      runHook postInstall
    '';

    # See https://nix-community.github.io/bun2nix/building-packages/hook.html#arguments for options
    dontFixup = true;
    dontStrip = true;
    dontRunLifecycleScripts = true;

    meta = with lib; {
      description = "Terminal diff viewer for agentic changesets";
      homepage = "https://github.com/modem-dev/hunk";
      license = licenses.mit;
      mainProgram = "hunk";
      platforms = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    };
  }
