import { describe, expect, test } from "bun:test";

import canonicalize from "canonicalize";

import { canonicalizeJson } from "../src/canonical-json";
import { parseStrictJson, StrictJsonError } from "../src/strict-json";

const UTF8_ENCODER = new TextEncoder();

// Source: RFC 8785 Appendix B, https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B
const RFC_8785_NUMBER_VECTORS = [
  ["0000000000000000", "0"],
  ["8000000000000000", "0"],
  ["0000000000000001", "5e-324"],
  ["8000000000000001", "-5e-324"],
  ["7fefffffffffffff", "1.7976931348623157e+308"],
  ["ffefffffffffffff", "-1.7976931348623157e+308"],
  ["4340000000000000", "9007199254740992"],
  ["c340000000000000", "-9007199254740992"],
  ["44b52d02c7e14af5", "9.999999999999997e+22"],
  ["44b52d02c7e14af6", "1e+23"],
  ["44b52d02c7e14af7", "1.0000000000000001e+23"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
  ["3eb0c6f7a0b5ed8d", "0.000001"],
  ["41b3de4355555555", "333333333.3333333"],
  ["43143ff3c1cb0959", "1424953923781206.2"],
] as const;

const RFC_8785_REJECTED_NUMBER_BITS = ["7fffffffffffffff", "7ff0000000000000"] as const;

// Source: https://github.com/cyberphone/json-canonicalization/tree/19d51d7fe467d4706a3ff08adf8a748f29fc21e0/testdata
const UPSTREAM_CANONICALIZATION_VECTORS = [
  {
    input: `[
  56,
  {
    "d": true,
    "10": null,
    "1": [ ]
  }
]`,
    name: "arrays",
    output: '[56,{"1":[],"10":null,"d":true}]',
    strictProfile: true,
  },
  {
    input: String.raw`{
  "Unnormalized Unicode":"A\u030a"
}`,
    name: "unicode",
    output: '{"Unnormalized Unicode":"Å"}',
    strictProfile: true,
  },
  {
    input: String.raw`{
  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
  "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
  "literals": [null, true, false]
}`,
    name: "values",
    output:
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    strictProfile: false,
  },
] as const;

function numberFromIeee754Hex(hex: string): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("canonicalizeJson", () => {
  test("freezes JCS UTF-8 bytes and their SHA-256 digest", () => {
    const result = canonicalizeJson({
      z: 0.000001,
      é: "\u96ea",
      a: [true, null, "😀"],
      n: Number("333333333.33333329"),
    });

    expect(result.text).toBe(
      '{"a":[true,null,"😀"],"n":333333333.3333333,"z":0.000001,"é":"\u96ea"}',
    );
    expect(result.bytes.byteLength).toBe(70);
    expect(Buffer.from(result.bytes).toString("hex")).toBe(
      "7b2261223a5b747275652c6e756c6c2c22f09f9880225d2c226e223a3333333333333333332e333333333333332c227a223a302e3030303030312c22c3a9223a22e99baa227d",
    );
    expect(result.sha256).toBe("5188e53fa4a0a1a96da4f4f37cc4d639fb84eca0de7543b128e30f169a331dea");
    expect(result.text.endsWith("\n")).toBe(false);
  });

  test("is independent of object insertion order", () => {
    const left = canonicalizeJson({ b: 2, a: { d: 4, c: 3 } });
    const right = canonicalizeJson({ a: { c: 3, d: 4 }, b: 2 });

    expect(left.text).toBe(right.text);
    expect(left.bytes).toEqual(right.bytes);
    expect(left.sha256).toBe(right.sha256);
  });

  test("does not normalize Unicode", () => {
    const composed = canonicalizeJson({ value: "Å" });
    const decomposed = canonicalizeJson({ value: "A\u030a" });

    expect(composed.text).not.toBe(decomposed.text);
    expect(composed.sha256).not.toBe(decomposed.sha256);
  });

  test("defensively rejects values outside the strict JSON profile", () => {
    expect(() => canonicalizeJson(-0)).toThrow(StrictJsonError);
  });

  test("matches the RFC 8785 Appendix B binary64 vectors", () => {
    for (const [bits, expected] of RFC_8785_NUMBER_VECTORS) {
      expect(canonicalize(numberFromIeee754Hex(bits))).toBe(expected);
    }
    for (const bits of RFC_8785_REJECTED_NUMBER_BITS) {
      expect(() => canonicalize(numberFromIeee754Hex(bits))).toThrow();
    }
  });

  test("keeps RFC serialization separate from the stricter project numeric profile", () => {
    expect(() => canonicalizeJson(numberFromIeee754Hex("8000000000000000"))).toThrow(
      StrictJsonError,
    );
    expect(() => canonicalizeJson(numberFromIeee754Hex("4340000000000000"))).toThrow(
      StrictJsonError,
    );
  });

  test("matches the pinned upstream arrays, unicode, and values vectors", () => {
    for (const vector of UPSTREAM_CANONICALIZATION_VECTORS) {
      expect(canonicalize(JSON.parse(vector.input))).toBe(vector.output);

      if (vector.strictProfile) {
        const parsed = parseStrictJson(UTF8_ENCODER.encode(vector.input));
        expect(canonicalizeJson(parsed).text).toBe(vector.output);
      } else {
        expect(() => parseStrictJson(UTF8_ENCODER.encode(vector.input))).toThrow(StrictJsonError);
      }
    }
  });
});
