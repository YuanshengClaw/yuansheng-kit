import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { assertStrictJsonValue } from "./strict-json";

export interface CanonicalJson {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly text: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalizeJson(value: unknown): CanonicalJson {
  assertStrictJsonValue(value);

  const text = canonicalize(value);
  if (text === undefined) {
    throw new TypeError("A strict JSON value must have a canonical JSON representation");
  }

  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    sha256: sha256Hex(bytes),
    text,
  };
}
