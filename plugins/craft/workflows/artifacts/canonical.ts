import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { JsonValue } from "./strict-json";

export interface CanonicalJson {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly text: string;
}

function assertJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value)))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical Craft values must use only strict JSON data types");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical Craft values must not contain cycles");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new TypeError("Canonical Craft objects must be plain data objects");
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Canonical Craft objects must contain enumerable data properties only");
      }
      assertJsonValue(descriptor.value, ancestors);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("Canonical Craft objects must not contain symbol properties");
    }
  }
  ancestors.delete(value);
}

export function sha256Digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalizeJson(value: unknown): CanonicalJson {
  assertJsonValue(value);
  const text = canonicalize(value);
  if (text === undefined) {
    throw new TypeError("A strict Craft JSON value must have canonical bytes");
  }
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    digest: sha256Digest(bytes),
    text,
  };
}

export function computeArtifactDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("A Craft artifact must be an object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "artifact_digest");
  if (descriptor !== undefined && !("value" in descriptor)) {
    throw new TypeError("artifact_digest must be a data property");
  }

  const payload = { ...value } as Record<string, unknown>;
  delete payload.artifact_digest;
  return canonicalizeJson(payload).digest;
}

export function sealArtifact<T extends Record<string, JsonValue>>(
  payload: T,
): T & { readonly artifact_digest: `sha256:${string}` } {
  if ("artifact_digest" in payload) {
    throw new TypeError("sealArtifact accepts an unsealed artifact payload");
  }
  const artifact = {
    ...payload,
    artifact_digest: "sha256:pending",
  };
  return {
    ...payload,
    artifact_digest: computeArtifactDigest(artifact),
  };
}
