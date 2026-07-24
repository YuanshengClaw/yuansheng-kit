import { describe, expect, test } from "bun:test";

import {
  CraftRuntimeConfigError,
  parseCraftRuntimeConfigBytes,
} from "../../plugins/craft/workflows/runtime-config/config";

const UTF8_ENCODER = new TextEncoder();

function bytes(value: unknown, indentation?: number): Uint8Array {
  return UTF8_ENCODER.encode(JSON.stringify(value, null, indentation));
}

function validConfig() {
  return {
    repository: {
      preparation_policy: "manual-or-managed",
      timeout_ms: 30_000,
    },
    verification: {
      runners: [
        {
          command_proposals: [{ argv: ["bun", "test"], id: "unit-tests" }],
          cwd: ".",
          id: "local",
          timeout_ms: 120_000,
          type: "local",
        },
        {
          command_proposals: [{ argv: ["pytest", "-q"], id: "remote-tests" }],
          host_alias: "ci-riscv",
          id: "remote",
          remote_cwd: "/srv/project",
          timeout_ms: 180_000,
          type: "ssh",
        },
      ],
    },
    version: 1,
  } as const;
}

describe("Yuansheng Craft runtime config", () => {
  test("normalizes only the frozen repository and verification policy", () => {
    const parsed = parseCraftRuntimeConfigBytes(bytes(validConfig(), 2));
    expect(parsed.config).toEqual({
      ...validConfig(),
      verification: {
        max_iterations: 5,
        runners: validConfig().verification.runners,
      },
    });
    expect(parsed.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(parseCraftRuntimeConfigBytes(bytes(validConfig())).configDigest).toBe(
      parsed.configDigest,
    );
  });

  test("accepts an explicit bounded iteration limit", () => {
    const config = validConfig();
    expect(
      parseCraftRuntimeConfigBytes(
        bytes({
          ...config,
          verification: { ...config.verification, max_iterations: 50 },
        }),
      ).config.verification.max_iterations,
    ).toBe(50);
  });

  test("rejects bypasses, model fields, credentials, and unknown policy", () => {
    const invalidValues = [
      { ...validConfig(), require_independent_review: false },
      { ...validConfig(), allow_plan_deviation: true },
      { ...validConfig(), model: "fixed-model" },
      { ...validConfig(), token: "secret" },
      {
        ...validConfig(),
        verification: {
          runners: [
            {
              command_proposals: [{ argv: ["curl", "--authorization", "secret"], id: "unsafe" }],
              cwd: ".",
              id: "local",
              timeout_ms: 120_000,
              type: "local",
            },
          ],
        },
      },
    ];
    for (const value of invalidValues) {
      expect(() => parseCraftRuntimeConfigBytes(bytes(value))).toThrow(CraftRuntimeConfigError);
    }
  });

  test("rejects invalid limits, paths, duplicate IDs, and permissive JSON", () => {
    const base = validConfig();
    const invalidValues = [
      {
        ...base,
        verification: { ...base.verification, max_iterations: 51 },
      },
      {
        ...base,
        verification: {
          runners: [
            {
              command_proposals: [{ argv: ["bun", "test"], id: "test" }],
              cwd: "../outside",
              id: "local",
              timeout_ms: 120_000,
              type: "local",
            },
          ],
        },
      },
      {
        ...base,
        verification: {
          runners: [
            base.verification.runners[0],
            {
              ...base.verification.runners[0],
              command_proposals: [{ argv: ["bun"], id: "other" }],
            },
          ],
        },
      },
      {
        ...base,
        verification: {
          runners: [
            {
              ...base.verification.runners[0],
              command_proposals: [
                { argv: ["bun", "test"], id: "same" },
                { argv: ["bun", "run", "typecheck"], id: "same" },
              ],
            },
          ],
        },
      },
    ];
    for (const value of invalidValues) {
      expect(() => parseCraftRuntimeConfigBytes(bytes(value))).toThrow(CraftRuntimeConfigError);
    }
    expect(() =>
      parseCraftRuntimeConfigBytes(
        UTF8_ENCODER.encode('{"repository":{},"repository":{},"verification":{},"version":1}'),
      ),
    ).toThrow(CraftRuntimeConfigError);
  });
});
