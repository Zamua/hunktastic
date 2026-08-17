{
  bun,
  bun2nix,
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
        --outfile "hunkt-bin"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp -p ./hunkt-bin $out/bin/hunkt
      # lib.getExe resolves the pname (hunkdiff) because the bun2nix builder does
      # not carry meta.mainProgram through, so keep that name pointing at the real
      # command rather than at a missing file.
      ln -s hunkt $out/bin/hunkdiff
      cp -r ./skills $out/
      wrapProgram $out/bin/hunkt --set HUNKT_INSTALL_SOURCE nix
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
      mainProgram = "hunkt";
      platforms = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    };
  }
