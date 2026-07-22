import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { type Node, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";

import { PluginBuilderError } from "./errors";
import type { JsonValue } from "./platform-handler";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function invalidManifestJson(message: string): PluginBuilderError {
  return new PluginBuilderError("manifest-json-invalid", "input", message);
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw invalidManifestJson("Manifest contains an unpaired Unicode surrogate");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw invalidManifestJson("Manifest contains an unpaired Unicode surrogate");
    }
  }
}

function validateStrictNode(node: Node, source: string): void {
  if (node.type === "string") {
    if (typeof node.value !== "string") {
      throw invalidManifestJson("Manifest contains an invalid string value");
    }
    assertUnicodeScalarString(node.value);
  } else if (node.type === "number") {
    if (typeof node.value !== "number" || !Number.isFinite(node.value)) {
      throw invalidManifestJson("Manifest numbers must be finite binary64 values");
    }
    const rawNumber = source.slice(node.offset, node.offset + node.length);
    const exponentOffset = rawNumber.search(/[eE]/u);
    const significand = exponentOffset === -1 ? rawNumber : rawNumber.slice(0, exponentOffset);
    if (node.value === 0 && /[1-9]/u.test(significand)) {
      throw invalidManifestJson("Manifest contains a number that underflows binary64");
    }
    if (Object.is(node.value, -0)) {
      throw invalidManifestJson("Manifest must not contain negative zero");
    }
    if (Number.isInteger(node.value) && !Number.isSafeInteger(node.value)) {
      throw invalidManifestJson("Manifest integers must remain within the safe integer range");
    }
  }

  for (const child of node.children ?? []) {
    validateStrictNode(child, source);
  }
}

function findDuplicateKey(node: Node): string | undefined {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (keyNode === undefined || valueNode === undefined || typeof keyNode.value !== "string") {
        throw new PluginBuilderError(
          "manifest-json-invalid",
          "input",
          "Manifest contains an invalid object member",
        );
      }
      if (seen.has(keyNode.value)) {
        return keyNode.value;
      }
      seen.add(keyNode.value);
      const nested = findDuplicateKey(valueNode);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (node.type === "array") {
    for (const child of node.children ?? []) {
      const nested = findDuplicateKey(child);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

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

export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new PluginBuilderError(
      "manifest-json-invalid",
      "input",
      "Manifest must not contain a UTF-8 byte order mark",
    );
  }

  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (cause) {
    throw new PluginBuilderError("manifest-json-invalid", "input", "Manifest is not valid UTF-8", {
      cause,
    });
  }

  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (root === undefined || errors.length > 0) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} at byte ${error.offset}`)
      .join(", ");
    throw new PluginBuilderError(
      "manifest-json-invalid",
      "input",
      detail.length > 0 ? `Manifest JSON is invalid: ${detail}` : "Manifest JSON is invalid",
    );
  }

  const duplicate = findDuplicateKey(root);
  if (duplicate !== undefined) {
    throw new PluginBuilderError(
      "manifest-json-invalid",
      "input",
      `Manifest contains duplicate object key ${JSON.stringify(duplicate)}`,
    );
  }
  validateStrictNode(root, text);
  return JSON.parse(text) as unknown;
}
