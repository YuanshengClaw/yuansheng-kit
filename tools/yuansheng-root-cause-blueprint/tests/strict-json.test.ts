import { describe, expect, test } from "bun:test";

import {
  assertStrictJsonValue,
  parseStrictJson,
  StrictJsonError,
  type StrictJsonErrorCode,
} from "../src/strict-json";

const UTF8_ENCODER = new TextEncoder();

function utf8(value: string): Uint8Array {
  return UTF8_ENCODER.encode(value);
}

function expectStrictError(operation: () => unknown, code: StrictJsonErrorCode): void {
  try {
    operation();
    throw new Error(`Expected StrictJsonError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(StrictJsonError);
    expect((error as StrictJsonError).code).toBe(code);
  }
}

describe("parseStrictJson", () => {
  test("parses valid JSON", () => {
    const parsed = parseStrictJson(
      utf8('{"message":"\\u96ea😀","nested":{"enabled":true},"values":[null,0,0.5]}'),
    );

    expect(parsed).toEqual({
      message: "\u96ea😀",
      nested: { enabled: true },
      values: [null, 0, 0.5],
    });
  });

  test("rejects duplicate decoded property names before object construction", () => {
    for (const source of [
      '{"key":1,"key":2}',
      '{"key":1,"\\u006bey":2}',
      '{"outer":{"key":1,"key":2}}',
    ]) {
      expectStrictError(() => parseStrictJson(utf8(source)), "duplicate-key");
    }
  });

  test("rejects comments and trailing commas", () => {
    for (const source of ["{/* comment */}", "[1 // comment\n]", '{"key":1,}', "[1,]"]) {
      expectStrictError(() => parseStrictJson(utf8(source)), "invalid-syntax");
    }
  });

  test("rejects invalid UTF-8 and a byte order mark", () => {
    const invalidInputs = [
      new Uint8Array([0xc0, 0xaf]),
      new Uint8Array([0x80]),
      new Uint8Array([0xe2, 0x82]),
      new Uint8Array([0xed, 0xa0, 0x80]),
      new Uint8Array([0xf4, 0x90, 0x80, 0x80]),
    ];

    for (const input of invalidInputs) {
      expectStrictError(() => parseStrictJson(input), "invalid-utf8");
    }
    expectStrictError(
      () => parseStrictJson(new Uint8Array([0xef, 0xbb, 0xbf, 0x6e, 0x75, 0x6c, 0x6c])),
      "unexpected-bom",
    );
  });

  test("rejects unpaired surrogates in values and property names", () => {
    for (const source of ['"\\ud800"', '"\\udc00"', '{"\\ud800":null}', '{"key":"\\ud800x"}']) {
      expectStrictError(() => parseStrictJson(utf8(source)), "invalid-unicode");
    }

    expect(parseStrictJson(utf8('"\\ud83d\\ude00"'))).toBe("😀");
  });

  test("rejects non-finite numbers, negative zero, and binary64 underflow", () => {
    for (const source of ["NaN", "Infinity", "-Infinity"]) {
      expectStrictError(() => parseStrictJson(utf8(source)), "invalid-syntax");
    }
    expectStrictError(() => parseStrictJson(utf8("1e309")), "non-finite-number");

    for (const source of ["-0", "-0.0", "-0e0", "-0E+999"]) {
      expectStrictError(() => parseStrictJson(utf8(source)), "negative-zero");
    }
    for (const source of ["1e-400", "-1e-400"]) {
      expectStrictError(() => parseStrictJson(utf8(source)), "number-underflow");
    }

    expect(parseStrictJson(utf8("0e-400"))).toBe(0);
    expect(parseStrictJson(utf8("5e-324"))).toBe(5e-324);
  });

  test("enforces the project safe-integer profile", () => {
    for (const value of ["-9007199254740991", "9007199254740991"]) {
      expect(parseStrictJson(utf8(value))).toBe(Number(value));
    }
    for (const value of ["-9007199254740992", "9007199254740992", "1e30"]) {
      expectStrictError(() => parseStrictJson(utf8(value)), "unsafe-integer");
    }
  });

  test("uses ECMAScript binary64 rounding required by JCS", () => {
    expect(parseStrictJson(utf8("333333333.33333329"))).toBe(333333333.3333333);
  });
});

describe("assertStrictJsonValue", () => {
  test("accepts JSON values", () => {
    expect(() => assertStrictJsonValue({ value: [null, true, "\u96ea", 0.5] })).not.toThrow();
  });

  test("rejects values canonicalize would otherwise normalize or omit", () => {
    const sparse = Array.from({ length: 1 });
    const invalidValues: unknown[] = [
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      9007199254740992,
      "\ud800",
      sparse,
      new Date(0),
    ];

    for (const value of invalidValues) {
      expect(() => assertStrictJsonValue(value)).toThrow(StrictJsonError);
    }
  });

  test("rejects cycles, accessors, and non-index array properties", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectStrictError(() => assertStrictJsonValue(cyclic), "cyclic-value");

    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    expectStrictError(() => assertStrictJsonValue(accessor), "invalid-json-value");

    const extendedArray: unknown[] = [];
    Object.assign(extendedArray, { extra: true });
    expectStrictError(() => assertStrictJsonValue(extendedArray), "invalid-json-value");
  });
});
