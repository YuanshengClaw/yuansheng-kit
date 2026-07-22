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
      systems,
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
