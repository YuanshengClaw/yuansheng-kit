import { expect, test } from "bun:test";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

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

interface StaticModuleReference {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

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

function importDeclarationIsTypeOnly(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (
    clause.name !== undefined ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings)
  ) {
    return false;
  }
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((specifier) => specifier.isTypeOnly)
  );
}

function exportDeclarationIsTypeOnly(declaration: ts.ExportDeclaration): boolean {
  if (declaration.isTypeOnly) {
    return true;
  }
  return (
    declaration.exportClause !== undefined &&
    ts.isNamedExports(declaration.exportClause) &&
    declaration.exportClause.elements.length > 0 &&
    declaration.exportClause.elements.every((specifier) => specifier.isTypeOnly)
  );
}

function staticModuleReferences(path: string, source: string): readonly StaticModuleReference[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const references: StaticModuleReference[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      references.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: importDeclarationIsTypeOnly(statement),
      });
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      references.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: exportDeclarationIsTypeOnly(statement),
      });
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      references.push({
        specifier: statement.moduleReference.expression.text,
        typeOnly: statement.isTypeOnly,
      });
    }
  }
  return references;
}

function pathIsInside(directory: string, path: string): boolean {
  const localPath = relative(directory, path);
  return (
    localPath === "" ||
    (localPath !== ".." && !localPath.startsWith(`..${sep}`) && !isAbsolute(localPath))
  );
}

function specifierResolvesInside(importer: string, specifier: string, directory: string): boolean {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
    return false;
  }
  return pathIsInside(directory, resolve(dirname(importer), specifier));
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

test("OpenCode API imports stay inside platform layers and their tests", async () => {
  const files = await collectFiles(WORKSPACE_ROOT);
  const offenders: string[] = [];
  for (const path of files) {
    if (!OPENCODE_SOURCE_EXTENSIONS.has(extname(path))) {
      continue;
    }
    const logicalPath = workspacePath(path);
    if (/^(?:plugins|tests)\/[^/]+\/opencode\//u.test(logicalPath)) {
      continue;
    }
    if (OPENCODE_API_PATTERN.test(await readFile(path, "utf8"))) {
      offenders.push(logicalPath);
    }
  }
  expect(offenders).toEqual([]);
});

test("platform-neutral plugin assets do not contain OpenCode registration markers", async () => {
  const sharedDirectories = [
    ...["agents", "commands", "resources", "skills", "transport", "workflows"].map((name) =>
      join(WORKSPACE_ROOT, "plugins/trace", name),
    ),
    ...["agents", "skills", "workflows"].map((name) => join(WORKSPACE_ROOT, "plugins/craft", name)),
  ];
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

test("OpenCode Craft package identity is canonical", async () => {
  const packageManifest: unknown = JSON.parse(
    await readFile(join(WORKSPACE_ROOT, "plugins/craft/opencode/package.json"), "utf8"),
  );
  const bunLock = Bun.JSONC.parse(await readFile(join(WORKSPACE_ROOT, "bun.lock"), "utf8"));
  expect(packageManifest).toMatchObject({
    name: "opencode-ys-craft",
  });
  expect(bunLock).toMatchObject({
    workspaces: {
      "plugins/craft/opencode": {
        name: "opencode-ys-craft",
      },
    },
  });
});

test("plugin builder remains platform-neutral", async () => {
  const builderRoot = join(WORKSPACE_ROOT, "tools/plugin-builder");
  const pluginRoots = ["craft", "trace"].map((plugin) => join(WORKSPACE_ROOT, "plugins", plugin));
  const builderSources = (await collectFiles(join(builderRoot, "src"))).filter((path) =>
    OPENCODE_SOURCE_EXTENSIONS.has(extname(path)),
  );
  const forbiddenImports: string[] = [];
  for (const path of builderSources) {
    const references = staticModuleReferences(path, await readFile(path, "utf8"));
    for (const reference of references) {
      const importsOpenCodeSdk = /^@opencode-ai\/plugin(?:\/|$)/u.test(reference.specifier);
      const importsPluginPackage =
        /^(?:@yuansheng-kit\/opencode-ys-trace|opencode-ys-craft)(?:\/|$)/u.test(
          reference.specifier,
        ) ||
        /^(?:plugins\/(?:craft|trace))(?:\/|$)/u.test(reference.specifier) ||
        pluginRoots.some((pluginRoot) =>
          specifierResolvesInside(path, reference.specifier, pluginRoot),
        );
      if (importsOpenCodeSdk || importsPluginPackage) {
        forbiddenImports.push(`${workspacePath(path)} -> ${reference.specifier}`);
      }
    }
  }
  expect(forbiddenImports.sort()).toEqual([]);
});

test("OpenCode platform handler imports plugin-builder contracts only as types", async () => {
  const builderRoot = join(WORKSPACE_ROOT, "tools/plugin-builder");
  const handlerPaths = ["craft", "trace"].map((plugin) =>
    join(WORKSPACE_ROOT, "plugins", plugin, "opencode/src/platform-handler.ts"),
  );
  for (const handlerPath of handlerPaths) {
    const references = staticModuleReferences(handlerPath, await readFile(handlerPath, "utf8"));
    const builderImports = references.filter(
      (reference) =>
        /^@yuansheng-kit\/plugin-builder(?:\/|$)/u.test(reference.specifier) ||
        specifierResolvesInside(handlerPath, reference.specifier, builderRoot),
    );

    expect(builderImports.length).toBeGreaterThan(0);
    expect(
      builderImports
        .filter((reference) => !reference.typeOnly)
        .map((reference) => reference.specifier)
        .sort(),
    ).toEqual([]);
  }
});
