import { isAbsolute, relative, resolve, sep } from "node:path";

import { PluginBuilderError, type PluginBuilderErrorCode } from "./errors";

const WINDOWS_DRIVE = /^[A-Za-z]:/u;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function assertSafeRelativePosixPath(
  value: string,
  code: PluginBuilderErrorCode,
  label: string,
): void {
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    WINDOWS_DRIVE.test(value) ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    throw new PluginBuilderError(code, "input", `${label} is not a safe relative POSIX path`);
  }

  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 255,
    )
  ) {
    throw new PluginBuilderError(code, "input", `${label} is not a safe relative POSIX path`);
  }
}

export function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

export function resolveInsideRoot(
  root: string,
  relativePath: string,
  code: PluginBuilderErrorCode,
  label: string,
): string {
  assertSafeRelativePosixPath(relativePath, code, label);
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!isPathWithin(root, candidate)) {
    throw new PluginBuilderError(code, "input", `${label} escapes the workspace root`);
  }
  return candidate;
}

export function assertNoTargetConflicts(paths: readonly string[]): void {
  const sorted = [...paths].sort(compareUtf8);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (current === undefined) {
      continue;
    }
    const previous = sorted[index - 1];
    if (previous === current || (previous !== undefined && current.startsWith(`${previous}/`))) {
      throw new PluginBuilderError(
        "output-path-conflict",
        "input",
        `Output paths conflict: ${JSON.stringify(previous)} and ${JSON.stringify(current)}`,
      );
    }
  }
}
