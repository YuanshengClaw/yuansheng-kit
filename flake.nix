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

            packages = {
              amd64-nixos =
                (nixpkgs.lib.nixosSystem {
                  inherit
                    system
                    ;

                  modules = [
                    {
                      nixpkgs = {
                        inherit
                          pkgs
                          ;
                      };
                    }
                    "${nixpkgs}/nixos/modules/virtualisation/qemu-vm.nix"
                    (
                      {
                        lib,
                        pkgs,
                        ...
                      }:
                      let
                        inherit (lib)
                          mkForce
                          ;
                      in
                      {
                        environment = {
                          systemPackages = [
                            pkgs.git
                            pkgs.llm-agents.opencode
                            (pkgs.python314.withPackages (
                              ps: with ps; [
                                pip
                              ]
                            ))
                          ];
                        };

                        networking = {
                          defaultGateway = {
                            address = "192.168.94.1";
                            interface = "eth0";
                          };

                          firewall = {
                            allowedTCPPorts = [
                              22
                            ];
                          };

                          hostName = "amd64-nixos";

                          interfaces = {
                            eth0 = {
                              ipv4 = {
                                addresses = [
                                  {
                                    address = "192.168.94.10";
                                    prefixLength = 24;
                                  }
                                ];
                              };

                              useDHCP = false;
                            };
                          };

                          nameservers = [
                            "1.1.1.1"
                            "8.8.8.8"
                          ];

                          useDHCP = false;
                        };

                        services = {
                          openssh = {
                            enable = true;
                            openFirewall = true;

                            settings = {
                              PasswordAuthentication = true;
                              PermitRootLogin = "no";
                            };
                          };
                        };

                        system = {
                          name = "amd64-nixos";
                          stateVersion = "26.05";
                        };

                        users = {
                          groups = {
                            test = {
                              gid = 1000;
                            };
                          };

                          mutableUsers = false;

                          users = {
                            test = {
                              createHome = true;
                              extraGroups = [
                                "wheel"
                              ];
                              group = "test";
                              home = "/home/test";
                              initialPassword = "test";
                              isNormalUser = true;
                              uid = 1000;
                            };
                          };
                        };

                        virtualisation = {
                          cores = 4;
                          diskSize = 20480;
                          memorySize = 4096;

                          qemu = {
                            networkingOptions = mkForce [
                              "-netdev tap,id=net0,ifname=amd64-nixos,script=no,downscript=no"
                              "-device virtio-net-pci,netdev=net0,mac=52:54:00:94:00:10"
                            ];
                          };
                        };
                      }
                    )
                  ];
                }).config.system.build.vm;

              riscv64-nixos =
                (nixpkgs.lib.nixosSystem {
                  modules = [
                    {
                      nixpkgs = {
                        buildPlatform = system;
                        hostPlatform = "riscv64-linux";
                      };

                      virtualisation = {
                        host = {
                          inherit
                            pkgs
                            ;
                        };
                      };
                    }
                    "${nixpkgs}/nixos/modules/virtualisation/qemu-vm.nix"
                    (
                      {
                        lib,
                        ...
                      }:
                      let
                        inherit (lib)
                          mkForce
                          ;
                      in
                      {
                        networking = {
                          defaultGateway = {
                            address = "192.168.95.1";
                            interface = "eth0";
                          };

                          firewall = {
                            allowedTCPPorts = [
                              22
                            ];
                          };

                          hostName = "riscv64-nixos";

                          interfaces = {
                            eth0 = {
                              ipv4 = {
                                addresses = [
                                  {
                                    address = "192.168.95.10";
                                    prefixLength = 24;
                                  }
                                ];
                              };

                              useDHCP = false;
                            };
                          };

                          nameservers = [
                            "1.1.1.1"
                            "8.8.8.8"
                          ];

                          useDHCP = false;
                        };

                        services = {
                          openssh = {
                            enable = true;
                            openFirewall = true;

                            settings = {
                              PasswordAuthentication = true;
                              PermitRootLogin = "no";
                            };
                          };
                        };

                        system = {
                          name = "riscv64-nixos";
                          stateVersion = "26.05";
                        };

                        users = {
                          groups = {
                            test = {
                              gid = 1000;
                            };
                          };

                          mutableUsers = false;

                          users = {
                            test = {
                              createHome = true;
                              extraGroups = [
                                "wheel"
                              ];
                              group = "test";
                              home = "/home/test";
                              initialPassword = "test";
                              isNormalUser = true;
                              uid = 1000;
                            };
                          };
                        };

                        virtualisation = {
                          cores = 4;
                          diskSize = 20480;
                          graphics = false;
                          memorySize = 4096;

                          qemu = {
                            networkingOptions = mkForce [
                              "-netdev tap,id=net0,ifname=riscv64-nixos,script=no,downscript=no"
                              "-device virtio-net-pci,netdev=net0,mac=52:54:00:95:00:10"
                            ];
                          };
                        };
                      }
                    )
                  ];
                }).config.system.build.vm;
            };

          };

        systems = import systems;
      };
}
