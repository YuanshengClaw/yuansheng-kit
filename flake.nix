{
  description = "Agent toolkit for RISC-V performance analysis and optimization";

  inputs = {
    devshell = {
      inputs = {
        nixpkgs = {
          follows = "nixpkgs";
        };
      };

      url = "git+https://github.com/numtide/devshell.git?ref=main";
    };

    bun = {
      inputs = {
        flake-parts = {
          follows = "flake-parts";
        };

        nixpkgs = {
          follows = "nixpkgs";
        };

        systems = {
          follows = "systems";
        };

        treefmt-nix = {
          follows = "treefmt";
        };
      };

      url = "git+https://github.com/nix-community/bun2nix.git?ref=master";
    };

    flake-parts = {
      inputs = {
        nixpkgs-lib = {
          follows = "nixpkgs";
        };
      };

      url = "git+https://github.com/hercules-ci/flake-parts.git?ref=main";
    };

    llm-agents = {
      inputs = {
        bun2nix = {
          follows = "bun";
        };

        flake-parts = {
          follows = "flake-parts";
        };

        nixpkgs = {
          follows = "nixpkgs";
        };

        systems = {
          follows = "systems";
        };

        treefmt-nix = {
          follows = "treefmt";
        };
      };

      url = "git+https://github.com/numtide/llm-agents.nix?ref=main";
    };

    nixpkgs = {
      url = "git+https://github.com/NixOS/nixpkgs.git?ref=nixos-unstable";
    };

    pyproject = {
      inputs = {
        nixpkgs = {
          follows = "nixpkgs";
        };
      };

      url = "git+https://github.com/pyproject-nix/pyproject.nix.git?ref=master";
    };

    pyproject-overlay = {
      inputs = {
        nixpkgs = {
          follows = "nixpkgs";
        };

        pyproject-nix = {
          follows = "pyproject";
        };

        uv2nix = {
          follows = "uv";
        };
      };

      url = "git+https://github.com/pyproject-nix/build-system-pkgs.git?ref=master";
    };

    systems = {
      url = "git+https://github.com/nix-systems/x86_64-linux.git?ref=main";
    };

    treefmt = {
      inputs = {
        nixpkgs = {
          follows = "nixpkgs";
        };
      };

      url = "git+https://github.com/numtide/treefmt-nix.git?ref=main";
    };

    uv = {
      inputs = {
        nixpkgs = {
          follows = "nixpkgs";
        };

        pyproject-nix = {
          follows = "pyproject";
        };
      };

      url = "git+https://github.com/pyproject-nix/uv2nix.git?ref=master";
    };
  };

  nixConfig = {
    extra-substituters = [
      "https://cache.numtide.com"
    ];

    extra-trusted-public-keys = [
      "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
    ];
  };

  outputs =
    inputs@{
      bun,
      devshell,
      flake-parts,
      llm-agents,
      nixpkgs,
      pyproject,
      pyproject-overlay,
      systems,
      uv,
      ...
    }:
    let
      inherit (flake-parts.lib)
        mkFlake
        ;
    in
    mkFlake
      {
        inherit
          inputs
          ;

        specialArgs = {
          projectRoot = ./.;
        };
      }
      {
        perSystem =
          {
            lib,
            pkgs,
            projectRoot,
            system,
            ...
          }:
          let
            inherit (lib)
              cleanSourceWith
              elem
              hasPrefix
              ;

            source = cleanSourceWith {
              src = projectRoot;

              filter =
                path: _type:
                let
                  name = baseNameOf (toString path);
                in
                !elem name [
                  ".direnv"
                  ".git"
                  ".mypy_cache"
                  ".pytest_cache"
                  ".ruff_cache"
                  ".venv"
                  "coverage"
                  "dist"
                  "node_modules"
                  "result"
                ]
                && !hasPrefix "result-" name;
            };

            bunDeps = pkgs.bun2nix.fetchBunDeps {
              bunNix = projectRoot + /bun.nix;
            };

          in
          {
            _module = {
              args = {
                pkgs = import nixpkgs {
                  inherit
                    system
                    ;

                  overlays = [
                    bun.overlays.default
                    devshell.overlays.default
                    llm-agents.overlays.shared-nixpkgs
                    (final: prev: {
                      mdformat = prev.mdformat.withPlugins (
                        ps: with ps; [
                          mdformat-footnote
                          mdformat-frontmatter
                          mdformat-gfm
                          mdformat-gfm-alerts
                        ]
                      );
                    })
                  ];
                };

                projectRoot = ./.;
              };
            };

            checks =
              let
                inherit (lib)
                  composeManyExtensions
                  ;

                inherit (pkgs)
                  runCommandLocal
                  ;

                ys-biome =
                  runCommandLocal "ys-biome"
                    {
                      nativeBuildInputs = with pkgs; [
                        biome
                        git
                      ];
                    }
                    ''
                      cp -R ${source} source
                      chmod -R u+w source
                      cd source
                      export HOME="$TMPDIR/home"
                      mkdir -p "$HOME"
                      if find . -type l -print -quit | grep -q .
                      then
                        echo "repository source contains a symbolic link" >&2
                        exit 1
                      fi
                      git init --quiet
                      printf '/biome-local-excluded.json\n' > .git/info/exclude
                      printf '{ invalid local fixture\n' > biome-local-excluded.json
                      git add --all
                      biome check --write .
                      git diff --exit-code -- .
                      biome ci .
                      touch "$out"
                    '';

                ys-bun = pkgs.stdenvNoCC.mkDerivation {
                  pname = "ys-bun-checks";
                  version = "0.0.0";

                  src = source;

                  nativeBuildInputs = [
                    llm-agents.packages.${system}.opencode
                  ]
                  ++ (with pkgs; [
                    bun2nix.hook
                    git
                    typescript
                  ]);

                  inherit
                    bunDeps
                    ;

                  bunInstallFlags = [
                    "--frozen-lockfile"
                    "--linker=isolated"
                  ];

                  dontRunLifecycleScripts = true;
                  dontUseBunPatch = true;

                  buildPhase = ''
                    runHook preBuild
                    mkdir -p "$TMPDIR/ys-bun-checks/opencode-capabilities"
                    export OPENCODE_CAPABILITY_EVIDENCE_DIR="$TMPDIR/ys-bun-checks/opencode-capabilities"
                    tsc --noEmit
                    bun test \
                      --reporter=junit \
                      --reporter-outfile="$TMPDIR/ys-bun-checks/junit.xml"
                    runHook postBuild
                  '';

                  installPhase = ''
                    runHook preInstall
                    evidenceRoot="$out/share/yuansheng-kit/checks/ys-bun"
                    test -s "$TMPDIR/ys-bun-checks/junit.xml"
                    test -s "$TMPDIR/ys-bun-checks/opencode-capabilities/runtime/version.json"
                    test -s "$TMPDIR/ys-bun-checks/opencode-capabilities/runtime/http-command.json"
                    test -s "$TMPDIR/ys-bun-checks/opencode-capabilities/runtime/plugin-tool-ask.json"
                    test -s "$TMPDIR/ys-bun-checks/opencode-capabilities/sdk-external/sdk-external.json"
                    mkdir -p "$evidenceRoot"
                    sed -E \
                      -e 's/ time="[^"]*"//g' \
                      -e 's/ hostname="[^"]*"//g' \
                      "$TMPDIR/ys-bun-checks/junit.xml" \
                      > "$evidenceRoot/junit.xml"
                    if grep -E ' (time|hostname)="' "$evidenceRoot/junit.xml"
                    then
                      echo "JUnit evidence contains non-deterministic attributes" >&2
                      exit 1
                    fi
                    cp -R \
                      "$TMPDIR/ys-bun-checks/opencode-capabilities" \
                      "$evidenceRoot/opencode-capabilities"
                    if grep -R -E \
                      'yuansheng-opencode-capabilities-|"durationMs"|sessionID[^[:alnum:]_]*ses_|timestamp[^[:alnum:]_]*[0-9]{4}-|run=[0-9A-Za-z]' \
                      "$evidenceRoot/opencode-capabilities"
                    then
                      echo "capability evidence contains non-deterministic runtime data" >&2
                      exit 1
                    fi
                    (
                      cd "$evidenceRoot"
                      find . -type f ! -name SHA256SUMS -print0 \
                        | sort -z \
                        | xargs -0 sha256sum \
                        > SHA256SUMS
                    )
                    runHook postInstall
                  '';
                };

                ys-bun-nix-drift =
                  runCommandLocal "ys-bun-nix-drift"
                    {
                      nativeBuildInputs = with pkgs; [
                        bun2nix
                        diffutils
                      ];
                    }
                    ''
                      cd ${source}
                      bun2nix \
                        -l bun.lock \
                        -o "$TMPDIR/bun.nix" \
                        -c ./
                      diff -u bun.nix "$TMPDIR/bun.nix"
                      touch "$out"
                    '';

                ys-trace-perf-data-validator =
                  let
                    workspace = uv.lib.workspace.loadWorkspace {
                      workspaceRoot =
                        projectRoot
                        + /plugins/trace/tools/perf-data-validator;
                    };

                    overlay = workspace.mkPyprojectOverlay {
                      sourcePreference = "wheel";
                    };

                    set =
                      (pkgs.callPackage pyproject.build.packages {
                        python = pkgs.python314;
                      }).overrideScope
                        (composeManyExtensions [
                          pyproject-overlay.overlays.wheel
                          overlay
                        ]);

                    env =
                      let
                        name = "ys-trace-perf-data-validator-python-env";
                      in
                      set.mkVirtualEnv name workspace.deps.all;
                  in
                  runCommandLocal "ys-trace-perf-data-validator"
                    {
                      nativeBuildInputs = [
                        env
                        pkgs.uv
                      ]
                      ++ (with pkgs; [
                        mypy
                        ruff
                      ]);
                    }
                    ''
                      cp -R ${source} source
                      chmod -R u+w source
                      cd source
                      export HOME="$TMPDIR/home"
                      export UV_CACHE_DIR="$TMPDIR/uv-cache"
                      export UV_NO_SYNC=1
                      export UV_PROJECT_ENVIRONMENT=${env}
                      export UV_PYTHON=${set.python.interpreter}
                      export UV_PYTHON_DOWNLOADS=never
                      mkdir -p "$HOME" "$UV_CACHE_DIR"
                      ruff format --check .
                      ruff check .
                      cd plugins/trace/tools/perf-data-validator
                      uv lock --check --offline
                      mypy --strict
                      uv run --locked pytest
                      touch "$out"
                    '';
              in
              {
                inherit
                  ys-biome
                  ys-bun
                  ys-bun-nix-drift
                  ys-trace-perf-data-validator
                  ;
              };

            devShells =
              let
                inherit (pkgs.devshell)
                  importTOML
                  mkShell
                  ;
              in
              {
                default = mkShell {
                  imports = [
                    (importTOML (projectRoot + /devshell.toml))
                  ];
                };
              };

            formatter =
              let
                inherit (lib)
                  makeBinPath
                  ;

                inherit (pkgs)
                  biome
                  git
                  mdformat
                  nixfmt
                  treefmt
                  writeShellScriptBin
                  ;
              in
              writeShellScriptBin "treefmt" ''
                set -euo pipefail
                export PATH=${
                  makeBinPath [
                    biome
                    git
                    mdformat
                    nixfmt
                  ]
                }
                exec ${treefmt}/bin/treefmt \
                  --config-file=${projectRoot + /treefmt.toml} \
                  --tree-root-file=flake.nix \
                  --walk=git \
                  "$@"
              '';

          };

        systems = import systems;
      };
}
