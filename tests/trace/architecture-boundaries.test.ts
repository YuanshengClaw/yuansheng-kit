import { expect, test } from "bun:test";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const WORKSPACE_ROOT = join(import.meta.dir, "../..");
const OPENCODE_API_PATTERN = /["']@opencode-ai\/plugin(?:\/[^"']*)?["']/u;
const OPENCODE_SDK_SPECIFIER = ["@opencode-ai", "plugin"].join("/");
const OPENCODE_FRONT_MATTER_FIELD = /^\s*(?:agent|mode|model|permission|tools?):\s*/mu;
const OPENCODE_JSON_FIELD = /"(?:agent|mode|model|permission|tools?)"\s*:/u;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const OPENCODE_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const SHARED_ASSET_EXTENSIONS = new Set([
  ...OPENCODE_SOURCE_EXTENSIONS,
  ".json",
  ".jsonc",
  ".md",
  ".yaml",
  ".yml",
]);
const IGNORED_DIRECTORIES = new Set([
  ".agents",
  ".codex",
  ".direnv",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "coverage",
  "dist",
  "node_modules",
  "provenance",
  "result",
]);

async function collectFiles(directory: string): Promise<readonly string[]> {
  const status = await lstat(directory).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (status === undefined) {
    return [];
  }
  if (status.isSymbolicLink()) {
    throw new Error(`Architecture boundary scan refuses symlink: ${workspacePath(directory)}`);
  }
  if (!status.isDirectory()) {
    throw new Error(`Architecture boundary scan expected a directory: ${workspacePath(directory)}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith("result-")) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Architecture boundary scan refuses symlink: ${workspacePath(path)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function workspacePath(path: string): string {
  return relative(WORKSPACE_ROOT, path).replaceAll("\\", "/");
}

function hasPlatformMarker(path: string, contents: string): boolean {
  if (
    contents.includes(".opencode/") ||
    contents.includes(".opencode\\") ||
    contents.includes(OPENCODE_SDK_SPECIFIER)
  ) {
    return true;
  }
  const extension = extname(path);
  if (extension === ".md") {
    const frontMatter = contents.match(FRONT_MATTER)?.[1];
    return frontMatter !== undefined && OPENCODE_FRONT_MATTER_FIELD.test(frontMatter);
  }
  if (extension === ".json" || extension === ".jsonc") {
    return OPENCODE_JSON_FIELD.test(contents);
  }
  if (extension === ".yaml" || extension === ".yml") {
    return OPENCODE_FRONT_MATTER_FIELD.test(contents);
  }
  return false;
}

test("OpenCode API imports stay inside the platform layer and its tests", async () => {
  const files = await collectFiles(WORKSPACE_ROOT);
  const offenders: string[] = [];
  for (const path of files) {
    if (!OPENCODE_SOURCE_EXTENSIONS.has(extname(path))) {
      continue;
    }
    const logicalPath = workspacePath(path);
    if (
      logicalPath.startsWith("plugins/trace/opencode/") ||
      logicalPath.startsWith("tests/trace/opencode/")
    ) {
      continue;
    }
    if (OPENCODE_API_PATTERN.test(await readFile(path, "utf8"))) {
      offenders.push(logicalPath);
    }
  }
  expect(offenders).toEqual([]);
});

test("platform-neutral trace assets do not contain OpenCode registration markers", async () => {
  const sharedDirectories = ["agents", "commands", "skills", "workflows"].map((name) =>
    join(WORKSPACE_ROOT, "plugins/trace", name),
  );
  const files = (await Promise.all(sharedDirectories.map(collectFiles))).flat();
  const offenders: string[] = [];
  for (const path of files) {
    const logicalPath = workspacePath(path);
    if (/(?:^|\/)\.?opencode(?:\/|$)/u.test(logicalPath)) {
      offenders.push(logicalPath);
      continue;
    }
    if (!SHARED_ASSET_EXTENSIONS.has(extname(path))) {
      continue;
    }
    const contents = await readFile(path, "utf8");
    if (hasPlatformMarker(path, contents)) {
      offenders.push(logicalPath);
    }
  }
  expect(offenders).toEqual([]);
});

test("OpenCode trace package identity is canonical", async () => {
  const packageManifest: unknown = JSON.parse(
    await readFile(join(WORKSPACE_ROOT, "plugins/trace/opencode/package.json"), "utf8"),
  );
  const bunLock = Bun.JSONC.parse(await readFile(join(WORKSPACE_ROOT, "bun.lock"), "utf8"));
  expect(packageManifest).toMatchObject({
    name: "@yuansheng-kit/opencode-ys-trace",
  });
  expect(bunLock).toMatchObject({
    workspaces: {
      "plugins/trace/opencode": {
        name: "@yuansheng-kit/opencode-ys-trace",
      },
    },
  });
});
