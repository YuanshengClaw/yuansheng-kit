import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { PluginBuilderError } from "./errors";
import type { JsonValue } from "./platform-handler";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new PluginBuilderError(
      "internal-error",
      "internal",
      "A value could not be serialized as canonical JSON",
    );
  }
  return serialized;
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
