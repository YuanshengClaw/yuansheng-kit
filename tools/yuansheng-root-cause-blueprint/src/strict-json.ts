import {
  type Node,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type StrictJsonErrorCode =
  | "cyclic-value"
  | "duplicate-key"
  | "invalid-json-value"
  | "invalid-syntax"
  | "invalid-unicode"
  | "invalid-utf8"
  | "negative-zero"
  | "non-finite-number"
  | "number-underflow"
  | "unexpected-bom"
  | "unsafe-integer";

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;
  readonly textOffset: number | undefined;

  constructor(code: StrictJsonErrorCode, message: string, textOffset?: number) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
    this.textOffset = textOffset;
  }
}

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;

const STRICT_PARSE_OPTIONS = {
  allowEmptyContent: false,
  allowTrailingComma: false,
  disallowComments: true,
} as const;

function hasUtf8ByteOrderMark(input: Uint8Array): boolean {
  return input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf;
}

function decodeUtf8(input: Uint8Array): string {
  if (hasUtf8ByteOrderMark(input)) {
    throw new StrictJsonError("unexpected-bom", "JSON input must not start with a UTF-8 BOM");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch (error) {
    throw new StrictJsonError(
      "invalid-utf8",
      `JSON input is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function assertUnicodeString(value: string, textOffset?: number): void {
  if (hasUnpairedSurrogate(value)) {
    throw new StrictJsonError(
      "invalid-unicode",
      "JSON strings and property names must not contain unpaired UTF-16 surrogates",
      textOffset,
    );
  }
}

function hasNonZeroSignificand(rawNumber: string): boolean {
  const exponentOffset = rawNumber.search(/[eE]/u);
  const significand = exponentOffset === -1 ? rawNumber : rawNumber.slice(0, exponentOffset);
  return /[1-9]/u.test(significand);
}

function assertJsonNumber(value: number, rawNumber?: string, textOffset?: number): void {
  if (!Number.isFinite(value)) {
    throw new StrictJsonError(
      "non-finite-number",
      "JSON numbers must be finite IEEE 754 binary64 values",
      textOffset,
    );
  }

  if (value === 0 && rawNumber !== undefined && hasNonZeroSignificand(rawNumber)) {
    throw new StrictJsonError(
      "number-underflow",
      `JSON number underflows binary64: ${rawNumber}`,
      textOffset,
    );
  }

  if (Object.is(value, -0)) {
    throw new StrictJsonError(
      "negative-zero",
      "Negative zero is forbidden at strict JSON boundaries",
      textOffset,
    );
  }

  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new StrictJsonError(
      "unsafe-integer",
      "JSON integers must be within the IEEE 754 safe integer range",
      textOffset,
    );
  }
}

function nodeChildren(node: Node): readonly Node[] {
  if (node.children === undefined) {
    throw new StrictJsonError(
      "invalid-syntax",
      `Incomplete ${node.type} node at UTF-16 offset ${node.offset}`,
      node.offset,
    );
  }
  return node.children;
}

function buildJsonValue(node: Node, source: string): JsonValue {
  switch (node.type) {
    case "null":
      return null;
    case "boolean":
      if (typeof node.value !== "boolean") {
        throw new StrictJsonError("invalid-syntax", "Invalid boolean node", node.offset);
      }
      return node.value;
    case "string":
      if (typeof node.value !== "string") {
        throw new StrictJsonError("invalid-syntax", "Invalid string node", node.offset);
      }
      assertUnicodeString(node.value, node.offset);
      return node.value;
    case "number": {
      const rawNumber = source.slice(node.offset, node.offset + node.length);
      if (!JSON_NUMBER.test(rawNumber)) {
        throw new StrictJsonError(
          "invalid-syntax",
          `Invalid JSON number at UTF-16 offset ${node.offset}`,
          node.offset,
        );
      }
      const value = Number(rawNumber);
      assertJsonNumber(value, rawNumber, node.offset);
      return value;
    }
    case "array":
      return nodeChildren(node).map((child) => buildJsonValue(child, source));
    case "object": {
      const result = Object.create(null) as Record<string, JsonValue>;
      const seenKeys = new Set<string>();

      for (const propertyNode of nodeChildren(node)) {
        if (propertyNode.type !== "property") {
          throw new StrictJsonError(
            "invalid-syntax",
            `Invalid object member at UTF-16 offset ${propertyNode.offset}`,
            propertyNode.offset,
          );
        }

        const propertyChildren = nodeChildren(propertyNode);
        const keyNode = propertyChildren[0];
        const valueNode = propertyChildren[1];
        if (
          propertyChildren.length !== 2 ||
          keyNode?.type !== "string" ||
          typeof keyNode.value !== "string" ||
          valueNode === undefined
        ) {
          throw new StrictJsonError(
            "invalid-syntax",
            `Incomplete object member at UTF-16 offset ${propertyNode.offset}`,
            propertyNode.offset,
          );
        }

        const key = keyNode.value;
        assertUnicodeString(key, keyNode.offset);
        if (seenKeys.has(key)) {
          throw new StrictJsonError(
            "duplicate-key",
            `Duplicate JSON property ${JSON.stringify(key)} at UTF-16 offset ${keyNode.offset}`,
            keyNode.offset,
          );
        }
        seenKeys.add(key);
        result[key] = buildJsonValue(valueNode, source);
      }

      return result;
    }
    case "property":
      throw new StrictJsonError(
        "invalid-syntax",
        `Property node is not a JSON value at UTF-16 offset ${node.offset}`,
        node.offset,
      );
  }
}

function firstParseErrorMessage(error: ParseError): string {
  return `${printParseErrorCode(error.error)} at UTF-16 offset ${error.offset}`;
}

export function parseStrictJson(input: Uint8Array): JsonValue {
  const source = decodeUtf8(input);
  const parseErrors: ParseError[] = [];
  const root = parseTree(source, parseErrors, STRICT_PARSE_OPTIONS);

  const firstError = parseErrors[0];
  if (firstError !== undefined) {
    throw new StrictJsonError(
      "invalid-syntax",
      `Invalid JSON: ${firstParseErrorMessage(firstError)}`,
      firstError.offset,
    );
  }
  if (root === undefined) {
    throw new StrictJsonError("invalid-syntax", "JSON input is empty");
  }

  return buildJsonValue(root, source);
}

function assertArrayValue(value: readonly unknown[], ancestors: Set<object>): void {
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new StrictJsonError("invalid-json-value", "JSON arrays must not have symbol keys");
    }
    if (key === "length") {
      continue;
    }

    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      throw new StrictJsonError(
        "invalid-json-value",
        `JSON arrays must not have non-index property ${JSON.stringify(key)}`,
      );
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new StrictJsonError("invalid-json-value", "JSON arrays must be dense data arrays");
    }
    assertJsonValueInternal(descriptor.value, ancestors);
  }
}

function assertObjectValue(value: object, ancestors: Set<object>): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new StrictJsonError(
      "invalid-json-value",
      "JSON objects must have Object.prototype or null as their prototype",
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new StrictJsonError("invalid-json-value", "JSON objects must not have symbol keys");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    assertUnicodeString(key);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new StrictJsonError(
        "invalid-json-value",
        `JSON property ${JSON.stringify(key)} must be an enumerable data property`,
      );
    }
    assertJsonValueInternal(descriptor.value, ancestors);
  }
}

function assertJsonValueInternal(
  value: unknown,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    assertUnicodeString(value);
    return;
  }
  if (typeof value === "number") {
    assertJsonNumber(value);
    return;
  }
  if (typeof value !== "object") {
    throw new StrictJsonError(
      "invalid-json-value",
      `Value of type ${typeof value} is not representable in JSON`,
    );
  }
  if (ancestors.has(value)) {
    throw new StrictJsonError("cyclic-value", "Cyclic values are not representable in JSON");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertArrayValue(value, ancestors);
    } else {
      assertObjectValue(value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertStrictJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueInternal(value, new Set<object>());
}
