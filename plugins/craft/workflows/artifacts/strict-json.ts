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

export class CraftJsonError extends Error {
  readonly code:
    | "duplicate-key"
    | "invalid-number"
    | "invalid-syntax"
    | "invalid-unicode"
    | "invalid-utf8"
    | "unexpected-bom";

  constructor(code: CraftJsonError["code"], message: string) {
    super(message);
    this.name = "CraftJsonError";
    this.code = code;
  }
}

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
const PARSE_OPTIONS = {
  allowEmptyContent: false,
  allowTrailingComma: false,
  disallowComments: true,
} as const;

function decodeUtf8(input: Uint8Array): string {
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    throw new CraftJsonError("unexpected-bom", "Craft JSON must not contain a UTF-8 BOM");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch (error) {
    throw new CraftJsonError(
      "invalid-utf8",
      `Craft JSON is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit === undefined || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new CraftJsonError(
          "invalid-unicode",
          "Craft JSON strings must not contain unpaired UTF-16 surrogates",
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CraftJsonError(
        "invalid-unicode",
        "Craft JSON strings must not contain unpaired UTF-16 surrogates",
      );
    }
  }
}

function children(node: Node): readonly Node[] {
  if (node.children === undefined) {
    throw new CraftJsonError("invalid-syntax", `Incomplete ${node.type} node`);
  }
  return node.children;
}

function parseNumber(node: Node, source: string): number {
  const raw = source.slice(node.offset, node.offset + node.length);
  if (!JSON_NUMBER.test(raw)) {
    throw new CraftJsonError("invalid-syntax", `Invalid JSON number ${raw}`);
  }
  const value = Number(raw);
  const significand = raw.split(/[eE]/u, 1)[0] ?? raw;
  const underflowed = value === 0 && /[1-9]/u.test(significand);
  if (
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    underflowed ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    throw new CraftJsonError(
      "invalid-number",
      "Craft JSON numbers must be finite, non-negative-zero binary64 values and integers must be safe",
    );
  }
  return value;
}

function buildValue(node: Node, source: string): JsonValue {
  switch (node.type) {
    case "null":
      return null;
    case "boolean":
      if (typeof node.value !== "boolean") {
        throw new CraftJsonError("invalid-syntax", "Invalid boolean");
      }
      return node.value;
    case "string":
      if (typeof node.value !== "string") {
        throw new CraftJsonError("invalid-syntax", "Invalid string");
      }
      assertUnicode(node.value);
      return node.value;
    case "number":
      return parseNumber(node, source);
    case "array":
      return children(node).map((child) => buildValue(child, source));
    case "object": {
      const result: Record<string, JsonValue> = {};
      const seen = new Set<string>();
      for (const property of children(node)) {
        const members = children(property);
        const key = members[0];
        const value = members[1];
        if (
          property.type !== "property" ||
          members.length !== 2 ||
          key?.type !== "string" ||
          typeof key.value !== "string" ||
          value === undefined
        ) {
          throw new CraftJsonError("invalid-syntax", "Invalid object member");
        }
        assertUnicode(key.value);
        if (seen.has(key.value)) {
          throw new CraftJsonError("duplicate-key", `Duplicate JSON property ${key.value}`);
        }
        if (["__proto__", "constructor", "prototype", "valueOf"].includes(key.value)) {
          throw new CraftJsonError("invalid-syntax", `Forbidden Craft JSON property ${key.value}`);
        }
        seen.add(key.value);
        Object.defineProperty(result, key.value, {
          configurable: true,
          enumerable: true,
          value: buildValue(value, source),
          writable: true,
        });
      }
      return result;
    }
    case "property":
      throw new CraftJsonError("invalid-syntax", "A property is not a JSON value");
  }
}

function parseErrorMessage(error: ParseError): string {
  return `${printParseErrorCode(error.error)} at UTF-16 offset ${error.offset}`;
}

export function parseStrictJson(input: Uint8Array): JsonValue {
  const source = decodeUtf8(input);
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, PARSE_OPTIONS);
  const firstError = errors[0];
  if (firstError !== undefined) {
    throw new CraftJsonError("invalid-syntax", `Invalid JSON: ${parseErrorMessage(firstError)}`);
  }
  if (root === undefined) {
    throw new CraftJsonError("invalid-syntax", "Craft JSON input is empty");
  }
  return buildValue(root, source);
}
