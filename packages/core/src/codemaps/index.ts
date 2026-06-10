import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, extname, join, sep } from "node:path";
import { createRequire } from "node:module";
import ParserModule from "@vscode/tree-sitter-wasm";
import type { CatalogFile, FileCatalog } from "../catalog/index.js";
import { atomicWriteJson, cacheDir, readJsonIfValid } from "../cache/index.js";
import type { Config } from "../config/index.js";
import { estimateTokens } from "../tokens/index.js";

const Parser = ParserModule.Parser;
const Language = ParserModule.Language;
const require = createRequire(import.meta.url);
const CODEMAP_CACHE_VERSION = 1;
const DEFAULT_FILE_TOKEN_CAP = 2000;

export type SupportedLanguage =
  | "ts"
  | "tsx"
  | "js"
  | "py"
  | "go"
  | "rust"
  | "swift"
  | "java"
  | "c"
  | "cpp"
  | "c_sharp"
  | "ruby"
  | "php"
  | "dart";

export interface FunctionInfo {
  name: string;
  definitionLine: string;
  lineNumber?: number;
}

export interface PropertyInfo {
  name: string;
  typeName?: string;
  definitionLine?: string;
}

export interface ClassInfo {
  name: string;
  methods: FunctionInfo[];
  properties: PropertyInfo[];
}

export interface InterfaceInfo {
  name: string;
  methods: FunctionInfo[];
  properties: PropertyInfo[];
}

export interface TypeAliasInfo {
  name: string;
  definitionLine: string;
}

export interface EnumInfo {
  name: string;
  cases: string[];
}

export interface VariableInfo {
  name: string;
  typeName?: string;
  definitionLine: string;
}

export interface FileApi {
  filePath: string;
  imports: string[];
  exports: string[];
  classes: ClassInfo[];
  interfaces: InterfaceInfo[];
  aliases: TypeAliasInfo[];
  literalUnions: string[];
  functions: FunctionInfo[];
  enums: EnumInfo[];
  globalVars: VariableInfo[];
  macros: string[];
  previews?: number;
  packageInfo?: PackageInfo;
  referencedTypes: string[];
  definedTypeNames: string[];
}

export interface PackageInfo {
  name?: string;
  products: string[];
  dependencies: string[];
  targets: string[];
}

export interface CodeStructureFile {
  path: string;
  text: string;
  fileApi: FileApi;
  cached: boolean;
}

export interface CodeStructureResult {
  files: CodeStructureFile[];
  limit_hit: boolean;
  omitted_total: number;
  suggestion?: string;
}

export interface WarmCodemapResult {
  cached: number;
  computed: number;
  skipped: number;
}

export type TypeIndex = Map<string, string[]>;

interface CacheEntry {
  version: number;
  contentSha256: string;
  mtimeMs: number;
  fileApi: FileApi;
}

type TsNode = ParserModule.Node;
type TsLanguage = ParserModule.Language;

interface LoadedLanguage {
  parser: ParserModule.Parser;
  language: TsLanguage;
}

const parserInit = Parser.init({
  locateFile(name: string) {
    return require.resolve(`@vscode/tree-sitter-wasm/wasm/${name}`);
  },
});
const languageMemo = new Map<SupportedLanguage, Promise<LoadedLanguage>>();

export function languageForPath(path: string): SupportedLanguage | undefined {
  const extension = extname(path).toLowerCase();
  if (path.endsWith("Package.swift")) return "swift";
  if (extension === ".ts") return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "js";
  if (extension === ".py") return "py";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if (extension === ".swift") return "swift";
  if (extension === ".java") return "java";
  if (extension === ".c" || extension === ".h") return "c";
  if ([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"].includes(extension)) return "cpp";
  if (extension === ".cs") return "c_sharp";
  if (extension === ".rb") return "ruby";
  if (extension === ".php") return "php";
  if (extension === ".dart") return "dart";
  return undefined;
}

export function canCodemapFile(file: CatalogFile, config: Config): boolean {
  const language = languageForPath(file.relativePath);
  if (!language || !config.codemaps.languages.includes(language)) return false;
  return !file.isBinary && !file.likelyGenerated;
}

export async function getCodeStructures(
  catalog: FileCatalog,
  config: Config,
  options: { paths: string[]; maxResults?: number },
): Promise<CodeStructureResult> {
  const candidates = expandPathCandidates(catalog, options.paths)
    .filter((file) => canCodemapFile(file, config))
    .slice(0, options.maxResults ?? 10);
  const files: CodeStructureFile[] = [];
  let usedTokens = 0;
  let omitted = 0;

  for (const file of candidates) {
    const loaded = await loadOrCreateFileApi(file, catalogRootForFile(catalog, file), config);
    if (!loaded) {
      omitted += 1;
      continue;
    }
    const text = serializeFileApi(loaded.fileApi);
    const tokens = estimateTokens(text);
    if (files.length > 0 && usedTokens + tokens > config.caps.structure_tokens) {
      omitted += 1;
      continue;
    }
    files.push({ path: file.relativePath, text, fileApi: loaded.fileApi, cached: loaded.cached });
    usedTokens += tokens;
  }

  omitted += Math.max(0, expandPathCandidates(catalog, options.paths).length - candidates.length);
  return {
    files,
    limit_hit: omitted > 0,
    omitted_total: omitted,
    ...(omitted > 0 ? { suggestion: "Narrow paths or raise caps.structure_tokens." } : {}),
  };
}

export async function warmCodemapCache(
  catalog: FileCatalog,
  config: Config,
): Promise<WarmCodemapResult> {
  const result: WarmCodemapResult = { cached: 0, computed: 0, skipped: 0 };
  const files = catalog.roots.flatMap((root) =>
    root.files.map((file) => ({ file, root: root.root })),
  );
  const queue = files.filter(({ file }) => canCodemapFile(file, config));
  result.skipped = files.length - queue.length;
  const workers = Math.max(1, config.concurrency.parse_workers || 4);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      while (index < queue.length) {
        const item = queue[index++]!;
        const loaded = await loadOrCreateFileApi(item.file, item.root, config);
        if (loaded?.cached) result.cached += 1;
        else if (loaded) result.computed += 1;
      }
    }),
  );
  return result;
}

export async function invalidateCodemapCacheEntry(
  root: string,
  relativePath: string,
  config: Config,
): Promise<void> {
  await rm(codemapCachePath(root, normalizePath(relativePath), config), { force: true });
}

export async function buildTypeIndex(catalog: FileCatalog, config: Config): Promise<TypeIndex> {
  const index: TypeIndex = new Map();
  for (const root of catalog.roots) {
    for (const file of root.files) {
      if (!canCodemapFile(file, config)) continue;
      const loaded = await loadOrCreateFileApi(file, root.root, config);
      for (const typeName of loaded?.fileApi.definedTypeNames ?? []) {
        const existing = index.get(typeName) ?? [];
        if (!existing.includes(file.relativePath)) existing.push(file.relativePath);
        index.set(typeName, existing.sort());
      }
    }
  }
  return index;
}

export function lookupDefiningFiles(index: TypeIndex | unknown, typeName: string): string[] {
  if (!(index instanceof Map)) return [];
  return index.get(typeName) ?? [];
}

export function serializeFileApi(api: FileApi, options: { maxTokens?: number } = {}): string {
  const maxTokens = options.maxTokens ?? DEFAULT_FILE_TOKEN_CAP;
  const lines: string[] = [`File: ${api.filePath}`, "Imports:"];
  lines.push(...api.imports.map((entry) => `  - ${entry}`));
  lines.push("---");

  appendClasses(lines, "Classes", api.classes, maxTokens);
  appendInterfaces(lines, api.interfaces, maxTokens);
  appendSimple(
    lines,
    "Type-aliases",
    api.aliases.map((alias) => alias.name),
    maxTokens,
  );
  appendSimple(lines, "Literal-union aliases", api.literalUnions, maxTokens);
  appendFunctions(lines, "Functions", api.functions, maxTokens);
  appendEnums(lines, api.enums, maxTokens);
  appendVars(lines, api.globalVars, maxTokens);
  appendPackage(lines, api.packageInfo, maxTokens);
  if (api.previews && api.previews > 0) lines.push("", `Previews: ${api.previews}`);
  appendSimple(lines, "Exports", api.exports, maxTokens);
  appendSimple(lines, "Macros", api.macros, maxTokens);
  lines.push("---");

  return lines.join("\n") + "\n";
}

async function loadOrCreateFileApi(
  file: CatalogFile,
  root: string,
  config: Config,
): Promise<{ fileApi: FileApi; cached: boolean } | null> {
  if (!canCodemapFile(file, config)) return null;
  const content = await readFile(file.absolutePath, "utf8");
  const contentSha256 = sha256(content);
  const cachePath = codemapCachePath(root, file.relativePath, config);
  const existing = await readJsonIfValid<CacheEntry>(cachePath);
  if (
    existing?.version === CODEMAP_CACHE_VERSION &&
    existing.contentSha256 === contentSha256 &&
    existing.mtimeMs === file.mtimeMs
  ) {
    return { fileApi: existing.fileApi, cached: true };
  }
  if (existing?.version === CODEMAP_CACHE_VERSION && existing.contentSha256 === contentSha256) {
    return { fileApi: existing.fileApi, cached: true };
  }

  const fileApi = await extractFileApi(file.relativePath, content);
  await atomicWriteJson(cachePath, {
    version: CODEMAP_CACHE_VERSION,
    contentSha256,
    mtimeMs: file.mtimeMs,
    fileApi,
  } satisfies CacheEntry);
  return { fileApi, cached: false };
}

async function extractFileApi(path: string, source: string): Promise<FileApi> {
  const language = languageForPath(path);
  if (!language) throw new Error(`Unsupported codemap language for ${path}`);
  const parser = await loadLanguage(language);
  const tree = parser.parser.parse(source);
  if (!tree) throw new Error(`Failed to parse ${path}`);
  const root = tree.rootNode;
  const api = emptyFileApi(path);
  switch (language) {
    case "ts":
    case "tsx":
    case "js":
      extractEcma(root, source, api, language);
      break;
    case "py":
      extractPython(root, source, api);
      break;
    case "go":
      extractGo(root, source, api);
      break;
    case "rust":
      extractRust(root, source, api);
      break;
    case "swift":
      extractSwift(root, source, api);
      break;
    case "java":
      extractJava(root, source, api);
      break;
    case "c":
      extractC(root, source, api);
      break;
    case "cpp":
      extractCpp(root, source, api);
      break;
    case "c_sharp":
      extractCSharp(root, source, api);
      break;
    case "ruby":
      extractRuby(root, source, api);
      break;
    case "php":
      extractPhp(root, source, api);
      break;
    case "dart":
      extractDart(root, source, api);
      break;
  }
  finalizeTypes(api);
  return api;
}

async function loadLanguage(language: SupportedLanguage): Promise<LoadedLanguage> {
  let existing = languageMemo.get(language);
  if (!existing) {
    existing = (async () => {
      await parserInit;
      const wasmName =
        language === "ts"
          ? "tree-sitter-typescript.wasm"
          : language === "c_sharp"
            ? "tree-sitter-c-sharp.wasm"
            : ["swift", "c", "dart"].includes(language)
              ? `tree-sitter-${language}.wasm`
              : language === "rust"
                ? "tree-sitter-rust.wasm"
                : language === "py"
                  ? "tree-sitter-python.wasm"
                  : language === "js"
                    ? "tree-sitter-javascript.wasm"
                    : `tree-sitter-${language}.wasm`;
      const wasmPath = ["swift", "c", "dart"].includes(language)
        ? require.resolve(`tree-sitter-wasms/out/${wasmName}`)
        : require.resolve(`@vscode/tree-sitter-wasm/wasm/${wasmName}`);
      const loadedLanguage = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(loadedLanguage);
      return { parser, language: loadedLanguage };
    })();
    languageMemo.set(language, existing);
  }
  return existing;
}

function extractEcma(
  root: TsNode,
  source: string,
  api: FileApi,
  language: SupportedLanguage,
): void {
  for (const child of namedChildren(root)) {
    const node = unwrapExport(child);
    if (child.type === "import_statement") api.imports.push(oneLine(child, source));
    if (child.type === "export_statement") api.exports.push(exportLine(child, source));
    if (node.type === "class_declaration") api.classes.push(extractEcmaClass(node, source));
    if (node.type === "interface_declaration")
      api.interfaces.push(extractEcmaInterface(node, source));
    if (node.type === "type_alias_declaration") {
      const name = text(node.childForFieldName("name"), source);
      if (name) api.aliases.push({ name, definitionLine: signatureLine(node, source) });
    }
    if (node.type === "enum_declaration") api.enums.push(extractEcmaEnum(node, source));
    if (node.type === "function_declaration") {
      const name = text(node.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, node, source));
    }
    if (["lexical_declaration", "variable_declaration"].includes(node.type)) {
      extractEcmaVariables(node, source, api, language);
    }
  }
}

function extractEcmaClass(node: TsNode, source: string): ClassInfo {
  const info: ClassInfo = {
    name: text(node.childForFieldName("name"), source) || "<anonymous>",
    methods: [],
    properties: [],
  };
  const body = node.childForFieldName("body");
  for (const member of namedChildren(body)) {
    if (
      ["method_definition", "method_signature", "abstract_method_signature"].includes(member.type)
    ) {
      const name = memberName(member, source);
      if (name) info.methods.push(fnInfo(name, member, source));
    } else if (member.type === "public_field_definition" || member.type === "field_definition") {
      const name = memberName(member, source);
      if (name) info.properties.push({ name, typeName: typeFromAnnotation(member, source) });
    }
  }
  return info;
}

function extractEcmaInterface(node: TsNode, source: string): InterfaceInfo {
  const info: InterfaceInfo = {
    name: text(node.childForFieldName("name"), source) || "<anonymous>",
    methods: [],
    properties: [],
  };
  const body = node.childForFieldName("body");
  for (const member of namedChildren(body)) {
    if (member.type.includes("method")) {
      const name = memberName(member, source);
      if (name) info.methods.push(fnInfo(name, member, source));
    } else if (member.type.includes("property")) {
      const name = memberName(member, source);
      if (name) info.properties.push({ name, typeName: typeFromAnnotation(member, source) });
    }
  }
  return info;
}

function extractEcmaEnum(node: TsNode, source: string): EnumInfo {
  const name = text(node.childForFieldName("name"), source) || "<anonymous>";
  const cases = descendants(node)
    .filter((child) => ["property_identifier", "identifier"].includes(child.type))
    .map((child) => text(child, source))
    .filter((entry) => entry && entry !== name);
  return { name, cases: unique(cases) };
}

function extractEcmaVariables(
  node: TsNode,
  source: string,
  api: FileApi,
  language: SupportedLanguage,
): void {
  for (const declarator of descendants(node).filter(
    (child) => child.type === "variable_declarator",
  )) {
    const nameNode = declarator.childForFieldName("name");
    const name = text(nameNode, source);
    if (!name) continue;
    const value = declarator.childForFieldName("value");
    const isFn =
      value && ["arrow_function", "function", "function_expression"].includes(value.type);
    if (isFn) {
      api.functions.push({
        name,
        definitionLine: signatureLine(declarator, source),
        lineNumber: declarator.startPosition.row + 1,
      });
    } else if (language !== "tsx") {
      api.globalVars.push({
        name,
        typeName: typeFromAnnotation(declarator, source),
        definitionLine: signatureLine(declarator, source),
      });
    }
  }
}

function extractPython(root: TsNode, source: string, api: FileApi): void {
  for (const child of namedChildren(root)) {
    if (["import_statement", "import_from_statement"].includes(child.type))
      api.imports.push(oneLine(child, source));
    if (child.type === "class_definition") {
      const name = text(child.childForFieldName("name"), source) || "<anonymous>";
      if (oneLine(child, source).includes("Enum")) {
        api.enums.push({
          name,
          cases: namedChildren(child.childForFieldName("body"))
            .filter((node) => node.type === "expression_statement")
            .map((node) =>
              text(
                descendants(node).find((item) => item.type === "identifier"),
                source,
              ),
            )
            .filter(Boolean),
        });
      } else {
        const cls: ClassInfo = { name, methods: [], properties: [] };
        for (const member of namedChildren(child.childForFieldName("body"))) {
          if (member.type === "function_definition") {
            const method = text(member.childForFieldName("name"), source);
            if (method) cls.methods.push(fnInfo(method, member, source));
          } else if (member.type === "expression_statement") {
            const prop = text(
              descendants(member).find((item) => item.type === "identifier"),
              source,
            );
            if (prop) cls.properties.push({ name: prop });
          }
        }
        api.classes.push(cls);
      }
    }
    if (child.type === "function_definition") {
      const name = text(child.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, child, source));
    }
    if (child.type === "expression_statement") {
      const variable = text(
        descendants(child).find((node) => node.type === "identifier"),
        source,
      );
      if (variable)
        api.globalVars.push({ name: variable, definitionLine: signatureLine(child, source) });
    }
  }
}

function extractGo(root: TsNode, source: string, api: FileApi): void {
  const classByName = new Map<string, ClassInfo>();
  for (const child of namedChildren(root)) {
    if (child.type === "import_declaration") api.imports.push(oneLine(child, source));
    if (child.type === "type_declaration") {
      const specs = descendants(child).filter((node) => node.type === "type_spec");
      for (const spec of specs) {
        if (!descendants(spec).some((node) => node.type === "struct_type")) continue;
        const name = text(spec.childForFieldName("name"), source);
        if (!name) continue;
        const cls: ClassInfo = {
          name,
          methods: [],
          properties: descendants(spec)
            .filter((node) => node.type === "field_identifier")
            .map((node) => ({ name: text(node, source) })),
        };
        api.classes.push(cls);
        classByName.set(name, cls);
      }
    }
    if (child.type === "function_declaration") {
      const name = text(child.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, child, source));
    }
    if (child.type === "method_declaration") {
      const name = text(child.childForFieldName("name"), source);
      const receiverType = descendants(child.childForFieldName("receiver"))
        .map((node) => text(node, source))
        .find((entry) => classByName.has(entry));
      if (name && receiverType)
        classByName.get(receiverType)!.methods.push(fnInfo(name, child, source));
    }
    if (["var_declaration", "const_declaration"].includes(child.type)) {
      for (const id of descendants(child).filter((node) => node.type === "identifier")) {
        api.globalVars.push({
          name: text(id, source),
          definitionLine: signatureLine(child, source),
        });
      }
    }
  }
}

function extractRust(root: TsNode, source: string, api: FileApi): void {
  const classByName = new Map<string, ClassInfo>();
  for (const child of namedChildren(root)) {
    if (child.type === "use_declaration") api.imports.push(oneLine(child, source));
    if (child.type === "struct_item") {
      const name = text(
        descendants(child).find((node) => node.type === "type_identifier"),
        source,
      );
      if (!name) continue;
      const cls: ClassInfo = {
        name,
        methods: [],
        properties: descendants(child)
          .filter((node) => node.type === "field_identifier")
          .map((node) => ({ name: text(node, source) })),
      };
      api.classes.push(cls);
      classByName.set(name, cls);
    }
    if (child.type === "enum_item") {
      const ids = descendants(child).filter((node) =>
        ["type_identifier", "identifier"].includes(node.type),
      );
      const name = text(ids[0], source);
      if (name) api.enums.push({ name, cases: ids.slice(1).map((node) => text(node, source)) });
    }
    if (child.type === "function_item") {
      const name = text(child.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, child, source));
    }
    if (child.type === "impl_item") {
      const target = descendants(child)
        .filter((node) => node.type === "type_identifier")
        .map((node) => text(node, source))
        .find((entry) => classByName.has(entry));
      const bucket = target ? classByName.get(target)!.methods : api.functions;
      for (const fn of descendants(child).filter((node) => node.type === "function_item")) {
        const name = text(fn.childForFieldName("name"), source);
        if (name) bucket.push(fnInfo(name, fn, source));
      }
    }
    if (["const_item", "static_item"].includes(child.type)) {
      const name = text(child.childForFieldName("name"), source);
      if (name) api.globalVars.push({ name, definitionLine: signatureLine(child, source) });
    }
  }
}

function extractSwift(root: TsNode, source: string, api: FileApi): void {
  for (const child of namedChildren(root)) {
    if (child.type === "import_declaration") api.imports.push(oneLine(child, source));
    if (child.type === "protocol_declaration") {
      api.interfaces.push(extractSwiftProtocol(child, source));
    }
    if (child.type === "class_declaration") {
      api.classes.push(extractSwiftClass(child, source));
    }
    if (child.type === "enum_declaration") api.enums.push(extractSwiftEnum(child, source));
    if (child.type === "typealias_declaration") {
      const name = text(
        descendants(child).find((node) => node.type === "type_identifier"),
        source,
      );
      if (name) api.aliases.push({ name, definitionLine: signatureLine(child, source) });
    }
    if (child.type === "function_declaration") {
      const name = text(child.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, child, source));
    }
    if (child.type === "property_declaration") {
      const prop = swiftProperty(child, source);
      if (prop)
        api.globalVars.push({ name: prop.name, definitionLine: prop.definitionLine ?? prop.name });
    }
  }
  api.previews = (source.match(/^\s*#Preview\b/gm) ?? []).length;
  if (api.filePath.endsWith("Package.swift")) api.packageInfo = extractPackageInfo(source);
}

function extractSwiftClass(node: TsNode, source: string): ClassInfo {
  const info: ClassInfo = {
    name:
      text(
        namedChildren(node).find((child) => child.type === "type_identifier"),
        source,
      ) || "<anonymous>",
    methods: [],
    properties: [],
  };
  for (const member of namedChildren(node.childForFieldName("body"))) {
    if (member.type === "function_declaration") {
      const name = text(member.childForFieldName("name"), source);
      if (name) info.methods.push(fnInfo(name, member, source));
    }
    if (member.type === "property_declaration") {
      const prop = swiftProperty(member, source);
      if (prop) info.properties.push(prop);
    }
  }
  return info;
}

function extractSwiftProtocol(node: TsNode, source: string): InterfaceInfo {
  const info: InterfaceInfo = {
    name:
      text(
        namedChildren(node).find((child) => child.type === "type_identifier"),
        source,
      ) || "<anonymous>",
    methods: [],
    properties: [],
  };
  for (const member of namedChildren(node.childForFieldName("body"))) {
    if (member.type === "protocol_function_declaration") {
      const name = text(member.childForFieldName("name"), source);
      if (name) info.methods.push(fnInfo(name, member, source));
    }
    if (member.type === "protocol_property_declaration" || member.type === "property_declaration") {
      const prop = swiftProperty(member, source);
      if (prop) info.properties.push(prop);
    }
  }
  return info;
}

function extractSwiftEnum(node: TsNode, source: string): EnumInfo {
  const name = text(
    namedChildren(node).find((child) => child.type === "type_identifier"),
    source,
  );
  const ids = descendants(node).filter((child) => child.type === "simple_identifier");
  return { name, cases: ids.slice(1).map((child) => text(child, source)) };
}

function swiftProperty(node: TsNode, source: string): PropertyInfo | undefined {
  const name = text(
    descendants(node).find((child) => child.type === "simple_identifier"),
    source,
  );
  if (!name) return undefined;
  const definitionLine = signatureLine(node, source);
  if (name === "body" && /:\s*some\s+View\b/.test(definitionLine)) {
    return { name: "View body", definitionLine: "View body" };
  }
  const typeName = typeFromAnnotation(node, source);
  return { name, typeName, definitionLine };
}

function extractPackageInfo(source: string): PackageInfo {
  return {
    name: firstMatch(source, /\bname:\s*"([^"]+)"/),
    products: callSummaries(source, /\.(library|executable|plugin)\s*\(([^)]*)\)/g),
    dependencies: callSummaries(source, /\.(package)\s*\(([^)]*)\)/g),
    targets: callSummaries(source, /\.(target|executableTarget|testTarget|plugin)\s*\(([^)]*)\)/g),
  };
}

function extractJava(root: TsNode, source: string, api: FileApi): void {
  for (const child of namedChildren(root)) {
    if (child.type === "import_declaration") api.imports.push(oneLine(child, source));
    if (child.type === "class_declaration") api.classes.push(extractJavaClass(child, source));
    if (child.type === "interface_declaration")
      api.interfaces.push(extractJavaInterface(child, source));
    if (child.type === "enum_declaration") api.enums.push(extractJavaEnum(child, source));
  }
}

function extractJavaClass(node: TsNode, source: string): ClassInfo {
  const info: ClassInfo = {
    name: text(node.childForFieldName("name"), source),
    methods: [],
    properties: [],
  };
  for (const member of namedChildren(node.childForFieldName("body"))) {
    if (["method_declaration", "constructor_declaration"].includes(member.type)) {
      const name = text(member.childForFieldName("name"), source);
      if (name) info.methods.push(fnInfo(name, member, source));
    }
    if (member.type === "field_declaration") {
      for (const declarator of descendants(member).filter(
        (child) => child.type === "variable_declarator",
      )) {
        const name = text(
          declarator.childForFieldName("name") ?? namedChildren(declarator)[0],
          source,
        );
        if (name) info.properties.push({ name, typeName: javaType(member, source) });
      }
    }
  }
  return info;
}

function extractJavaInterface(node: TsNode, source: string): InterfaceInfo {
  const info: InterfaceInfo = {
    name: text(node.childForFieldName("name"), source),
    methods: [],
    properties: [],
  };
  for (const method of descendants(node).filter((child) => child.type === "method_declaration")) {
    const name = text(method.childForFieldName("name"), source);
    if (name) info.methods.push(fnInfo(name, method, source));
  }
  return info;
}

function extractJavaEnum(node: TsNode, source: string): EnumInfo {
  const name = text(node.childForFieldName("name"), source);
  const cases = descendants(node)
    .filter((child) => child.type === "enum_constant")
    .map((child) => text(child.childForFieldName("name") ?? namedChildren(child)[0], source));
  return { name, cases };
}

function extractC(root: TsNode, source: string, api: FileApi): void {
  extractCFamily(root, source, api, false);
}

function extractCpp(root: TsNode, source: string, api: FileApi): void {
  extractCFamily(root, source, api, true);
}

function extractCFamily(root: TsNode, source: string, api: FileApi, isCpp: boolean): void {
  const nodes = descendants(root);
  api.imports.push(
    ...nodes.filter((node) => node.type === "preproc_include").map((node) => oneLine(node, source)),
  );
  api.macros.push(
    ...nodes
      .filter((node) => ["preproc_def", "preproc_function_def"].includes(node.type))
      .map((node) =>
        text(
          descendants(node).find((child) => child.type === "identifier"),
          source,
        ),
      ),
  );
  for (const node of nodes) {
    if (["struct_specifier", "class_specifier", "union_specifier"].includes(node.type)) {
      const name = text(
        descendants(node).find((child) => child.type === "type_identifier"),
        source,
      );
      if (!name || api.classes.some((entry) => entry.name === name)) continue;
      api.classes.push({
        name,
        methods: namedChildren(node.childForFieldName("body"))
          .filter((member) => member.type === "function_declarator")
          .map((member) =>
            fnInfo(text(member.childForFieldName("declarator"), source), member, source),
          ),
        properties: descendants(node)
          .filter((child) => child.type === "field_identifier")
          .map((child) => ({ name: text(child, source) })),
      });
    }
    if (node.type === "enum_specifier") {
      const ids = descendants(node).filter((child) =>
        ["type_identifier", "identifier"].includes(child.type),
      );
      const name = text(ids[0], source);
      if (name && !api.enums.some((entry) => entry.name === name))
        api.enums.push({ name, cases: ids.slice(1).map((child) => text(child, source)) });
    }
    if (node.type === "type_definition") {
      const name = text(
        descendants(node).find((child) => child.type === "type_identifier"),
        source,
      );
      if (name) api.aliases.push({ name, definitionLine: signatureLine(node, source) });
    }
    if (node.type === "function_definition") {
      const declarator = descendants(node).find((child) => child.type === "function_declarator");
      const name = functionDeclaratorName(declarator, source);
      if (name) api.functions.push(fnInfo(name, node, source));
    }
  }
  if (!isCpp) {
    for (const declaration of namedChildren(root).filter((node) => node.type === "declaration")) {
      for (const declarator of descendants(declaration).filter(
        (node) => node.type === "init_declarator",
      )) {
        const name = text(
          descendants(declarator).find((child) => child.type === "identifier"),
          source,
        );
        if (name) api.globalVars.push({ name, definitionLine: signatureLine(declaration, source) });
      }
    }
  }
}

function extractCSharp(root: TsNode, source: string, api: FileApi): void {
  const nodes = descendants(root);
  api.imports.push(
    ...nodes.filter((node) => node.type === "using_directive").map((node) => oneLine(node, source)),
  );
  for (const node of nodes) {
    if (
      node.type === "class_declaration" ||
      node.type === "struct_declaration" ||
      node.type === "record_declaration"
    ) {
      api.classes.push(extractCSharpClass(node, source));
    }
    if (node.type === "interface_declaration")
      api.interfaces.push(extractCSharpInterface(node, source));
    if (node.type === "enum_declaration") api.enums.push(extractCSharpEnum(node, source));
  }
}

function extractCSharpClass(node: TsNode, source: string): ClassInfo {
  const info: ClassInfo = {
    name: text(node.childForFieldName("name"), source),
    methods: [],
    properties: [],
  };
  for (const member of namedChildren(node.childForFieldName("body"))) {
    if (["method_declaration", "constructor_declaration"].includes(member.type)) {
      const name = text(member.childForFieldName("name"), source);
      if (name) info.methods.push(fnInfo(name, member, source));
    }
    if (member.type === "property_declaration" || member.type === "field_declaration") {
      const name = text(
        member.childForFieldName("name") ??
          descendants(member).find((child) => child.type === "identifier"),
        source,
      );
      if (name) info.properties.push({ name, typeName: csharpType(member, source) });
    }
  }
  return info;
}

function extractCSharpInterface(node: TsNode, source: string): InterfaceInfo {
  const info: InterfaceInfo = {
    name: text(node.childForFieldName("name"), source),
    methods: [],
    properties: [],
  };
  for (const method of descendants(node).filter((child) => child.type === "method_declaration")) {
    const name = text(method.childForFieldName("name"), source);
    if (name) info.methods.push(fnInfo(name, method, source));
  }
  return info;
}

function extractCSharpEnum(node: TsNode, source: string): EnumInfo {
  const name = text(node.childForFieldName("name"), source);
  const cases = descendants(node)
    .filter((child) => child.type === "enum_member_declaration")
    .map((child) =>
      text(
        descendants(child).find((item) => item.type === "identifier"),
        source,
      ),
    );
  return { name, cases };
}

function extractRuby(root: TsNode, source: string, api: FileApi): void {
  for (const child of namedChildren(root)) {
    if (child.type === "call" && /^(require|require_relative)\b/.test(oneLine(child, source)))
      api.imports.push(oneLine(child, source));
    if (child.type === "class" || child.type === "module")
      api.classes.push(extractRubyClass(child, source));
    if (child.type === "method") {
      const name = text(child.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, child, source));
    }
  }
}

function extractRubyClass(node: TsNode, source: string): ClassInfo {
  const info: ClassInfo = {
    name: text(
      descendants(node).find((child) => ["constant", "scope_resolution"].includes(child.type)),
      source,
    ),
    methods: [],
    properties: [],
  };
  for (const child of descendants(node)) {
    if (child === node) continue;
    if (child.type === "method" || child.type === "singleton_method") {
      const name = text(child.childForFieldName("name"), source);
      if (name) info.methods.push(fnInfo(name, child, source));
    }
    if (child.type === "assignment") {
      const name = text(namedChildren(child)[0], source);
      if (name && !info.properties.some((prop) => prop.name === name))
        info.properties.push({ name });
    }
  }
  return info;
}

function extractPhp(root: TsNode, source: string, api: FileApi): void {
  const nodes = descendants(root);
  api.imports.push(
    ...nodes
      .filter((node) => node.type === "namespace_use_declaration")
      .map((node) => oneLine(node, source)),
  );
  for (const node of nodes) {
    if (node.type === "class_declaration" || node.type === "trait_declaration")
      api.classes.push(extractPhpClass(node, source));
    if (node.type === "interface_declaration")
      api.interfaces.push(extractPhpInterface(node, source));
    if (node.type === "enum_declaration") api.enums.push(extractPhpEnum(node, source));
    if (node.type === "function_definition") {
      const name = text(node.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, node, source));
    }
  }
}

function extractPhpClass(node: TsNode, source: string): ClassInfo {
  const info: ClassInfo = {
    name: text(node.childForFieldName("name"), source),
    methods: [],
    properties: [],
  };
  for (const member of namedChildren(node.childForFieldName("body"))) {
    if (member.type === "method_declaration") {
      const name = text(member.childForFieldName("name"), source);
      if (name) info.methods.push(fnInfo(name, member, source));
    }
    if (member.type === "property_declaration") {
      for (const prop of descendants(member).filter((child) => child.type === "property_element")) {
        const name = text(prop, source).replace(/^\$/, "");
        if (name) info.properties.push({ name, typeName: phpType(member, source) });
      }
    }
  }
  return info;
}

function extractPhpInterface(node: TsNode, source: string): InterfaceInfo {
  const info: InterfaceInfo = {
    name: text(node.childForFieldName("name"), source),
    methods: [],
    properties: [],
  };
  for (const method of descendants(node).filter((child) => child.type === "method_declaration")) {
    const name = text(method.childForFieldName("name"), source);
    if (name) info.methods.push(fnInfo(name, method, source));
  }
  return info;
}

function extractPhpEnum(node: TsNode, source: string): EnumInfo {
  const name = text(node.childForFieldName("name"), source);
  const cases = descendants(node)
    .filter((child) => child.type === "enum_case")
    .map((child) => text(child.childForFieldName("name") ?? namedChildren(child)[0], source));
  return { name, cases };
}

function extractDart(root: TsNode, source: string, api: FileApi): void {
  for (const child of namedChildren(root)) {
    if (child.type === "import_or_export") api.imports.push(oneLine(child, source));
    if (child.type === "type_alias") {
      const name = text(
        descendants(child).find((node) => node.type === "type_identifier"),
        source,
      );
      if (name) api.aliases.push({ name, definitionLine: signatureLine(child, source) });
    }
    if (child.type === "enum_declaration") api.enums.push(extractDartEnum(child, source));
    if (child.type === "class_definition") api.classes.push(extractDartClass(child, source));
    if (child.type === "function_signature") {
      const name = text(child.childForFieldName("name"), source);
      if (name) api.functions.push(fnInfo(name, child, source));
    }
  }
}

function extractDartClass(node: TsNode, source: string): ClassInfo {
  const info: ClassInfo = {
    name: text(node.childForFieldName("name"), source),
    methods: [],
    properties: [],
  };
  for (const member of namedChildren(node.childForFieldName("body"))) {
    if (member.type === "declaration") {
      const signature = descendants(member).find((child) =>
        [
          "constructor_signature",
          "function_signature",
          "getter_signature",
          "setter_signature",
        ].includes(child.type),
      );
      if (signature) {
        const name = dartMethodName(signature, source);
        if (name) info.methods.push(fnInfo(name, member, source));
      } else {
        const name = text(
          descendants(member).find((child) => child.type === "initialized_identifier_list"),
          source,
        );
        if (name) info.properties.push({ name, typeName: dartType(member, source) });
      }
    }
    if (member.type === "method_signature") {
      const name = dartMethodName(member, source);
      if (name) info.methods.push(fnInfo(name, member, source));
    }
  }
  return info;
}

function extractDartEnum(node: TsNode, source: string): EnumInfo {
  const name = text(node.childForFieldName("name"), source);
  const cases = descendants(node)
    .filter((child) => child.type === "enum_constant")
    .map((child) => text(child.childForFieldName("name") ?? namedChildren(child)[0], source));
  return { name, cases };
}

function appendClasses(
  lines: string[],
  title: string,
  classes: ClassInfo[],
  maxTokens: number,
): void {
  if (classes.length === 0) return;
  lines.push("", `${title}:`);
  for (const cls of classes) {
    lines.push(`  - ${cls.name}`);
    appendFunctions(lines, "Methods", cls.methods, maxTokens, "    ", "      ");
    appendProps(lines, "Properties", cls.properties, maxTokens, "    ", "      ");
  }
}

function appendInterfaces(lines: string[], interfaces: InterfaceInfo[], maxTokens: number): void {
  if (interfaces.length === 0) return;
  lines.push("", "Interfaces:");
  for (const iface of interfaces) {
    lines.push(`  - ${iface.name}`);
    appendFunctions(lines, "Methods", iface.methods, maxTokens, "    ", "      ");
    appendProps(lines, "Properties", iface.properties, maxTokens, "    ", "      ");
  }
}

function appendFunctions(
  lines: string[],
  title: string,
  values: FunctionInfo[],
  maxTokens: number,
  titleIndent = "",
  itemIndent = "  ",
): void {
  if (values.length === 0) return;
  lines.push(`${titleIndent}${title}:`);
  appendCapped(
    lines,
    values.map((fn) => `${fn.lineNumber ? `L${fn.lineNumber}: ` : ""}${fn.definitionLine}`),
    itemIndent,
    maxTokens,
  );
}

function appendProps(
  lines: string[],
  title: string,
  values: PropertyInfo[],
  maxTokens: number,
  titleIndent = "",
  itemIndent = "  ",
): void {
  if (values.length === 0) return;
  lines.push(`${titleIndent}${title}:`);
  appendCapped(
    lines,
    values.map((prop) =>
      prop.definitionLine
        ? prop.definitionLine
        : prop.typeName
          ? `${prop.name}: ${prop.typeName}`
          : prop.name,
    ),
    itemIndent,
    maxTokens,
  );
}

function appendEnums(lines: string[], values: EnumInfo[], maxTokens: number): void {
  if (values.length === 0) return;
  lines.push("", "Enums:");
  appendCapped(
    lines,
    values.map((entry) => entry.name),
    "  ",
    maxTokens,
  );
}

function appendVars(lines: string[], values: VariableInfo[], maxTokens: number): void {
  if (values.length === 0) return;
  lines.push("", "Global vars:");
  appendCapped(
    lines,
    values.map((entry) => (entry.typeName ? `${entry.name}: ${entry.typeName}` : entry.name)),
    "  ",
    maxTokens,
  );
}

function appendPackage(lines: string[], info: PackageInfo | undefined, maxTokens: number): void {
  if (!info) return;
  lines.push("", "Package:");
  if (info.name) lines.push(`  - name: ${info.name}`);
  appendSimple(lines, "Products", info.products, maxTokens);
  appendSimple(lines, "Dependencies", info.dependencies, maxTokens);
  appendSimple(lines, "Targets", info.targets, maxTokens);
}

function appendSimple(lines: string[], title: string, values: string[], maxTokens: number): void {
  if (values.length === 0) return;
  lines.push("", `${title}:`);
  appendCapped(lines, values, "  ", maxTokens);
}

function appendCapped(lines: string[], values: string[], indent: string, maxTokens: number): void {
  const startLength = lines.length;
  for (const value of values) {
    lines.push(`${indent}- ${value}`);
    if (estimateTokens(lines.join("\n")) > maxTokens) {
      const kept = Math.max(1, lines.length - startLength - 1);
      lines.splice(startLength + kept);
      lines.push(`${indent}- ... (+${values.length - kept} more)`);
      return;
    }
  }
}

function expandPathCandidates(catalog: FileCatalog, paths: string[]): CatalogFile[] {
  const normalized = paths.map(normalizePath);
  return catalog.roots.flatMap((root) =>
    root.files.filter((file) =>
      normalized.some(
        (requested) =>
          file.relativePath === requested || file.relativePath.startsWith(`${requested}/`),
      ),
    ),
  );
}

function catalogRootForFile(catalog: FileCatalog, file: CatalogFile): string {
  return catalog.roots.find((root) => root.files.includes(file))?.root ?? dirnameFallback(file);
}

function dirnameFallback(file: CatalogFile): string {
  const suffix = file.relativePath.split("/").join(sep);
  return file.absolutePath.endsWith(suffix)
    ? file.absolutePath.slice(0, -suffix.length).replace(/[\\/]$/, "")
    : process.cwd();
}

function codemapCachePath(root: string, relativePath: string, config: Config): string {
  const configured = config.codemaps.cache_dir || ".rp-mini/codemap-cache";
  const dir = configured.startsWith(".rp-mini")
    ? join(root, configured)
    : join(cacheDir(root), "codemap-cache");
  return join(dir, `${sha256(relativePath)}.json`);
}

function emptyFileApi(filePath: string): FileApi {
  return {
    filePath,
    imports: [],
    exports: [],
    classes: [],
    interfaces: [],
    aliases: [],
    literalUnions: [],
    functions: [],
    enums: [],
    globalVars: [],
    macros: [],
    referencedTypes: [],
    definedTypeNames: [],
  };
}

function finalizeTypes(api: FileApi): void {
  const defined = [
    ...api.classes.map((entry) => entry.name),
    ...api.interfaces.map((entry) => entry.name),
    ...api.aliases.map((entry) => entry.name),
    ...api.enums.map((entry) => entry.name),
  ];
  api.definedTypeNames = unique(defined);
  const textSurface = JSON.stringify(api);
  api.referencedTypes = unique(
    [...textSurface.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)]
      .map((match) => match[0])
      .filter((name) => !api.definedTypeNames.includes(name) && !PRIMITIVES.has(name)),
  ).sort();
}

const PRIMITIVES = new Set(["String", "Number", "Boolean", "Object", "Array", "Promise", "React"]);

function namedChildren(node: TsNode | null | undefined): TsNode[] {
  return (node?.namedChildren ?? []).filter((child): child is TsNode => child !== null);
}

function descendants(node: TsNode | null | undefined): TsNode[] {
  if (!node) return [];
  return [node, ...namedChildren(node).flatMap(descendants)];
}

function unwrapExport(node: TsNode): TsNode {
  if (node.type !== "export_statement") return node;
  return (
    node.childForFieldName("declaration") ??
    namedChildren(node).find((child) => child.type !== "string") ??
    node
  );
}

function memberName(node: TsNode, source: string): string {
  return text(node.childForFieldName("name"), source).replace(/\?$/, "");
}

function fnInfo(name: string, node: TsNode, source: string): FunctionInfo {
  return {
    name,
    definitionLine: signatureLine(node, source),
    lineNumber: node.startPosition.row + 1,
  };
}

function signatureLine(node: TsNode, source: string): string {
  let end = node.endIndex;
  const body = node.childForFieldName("body");
  if (body) end = Math.max(node.startIndex, body.startIndex);
  let raw = source.slice(node.startIndex, end).trim();
  raw = raw
    .replace(/\s*\{\s*$/, "")
    .replace(/\s*:\s*$/, ":")
    .replace(/\s+/g, " ");
  if (!raw) raw = oneLine(node, source);
  return raw;
}

function typeFromAnnotation(node: TsNode, source: string): string | undefined {
  const annotation = descendants(node).find((child) => child.type === "type_annotation");
  if (!annotation) return undefined;
  return text(annotation, source).replace(/^:\s*/, "").trim() || undefined;
}

function javaType(node: TsNode, source: string): string | undefined {
  return text(
    namedChildren(node).find((child) =>
      ["type_identifier", "generic_type", "void_type", "integral_type", "boolean_type"].includes(
        child.type,
      ),
    ),
    source,
  );
}

function csharpType(node: TsNode, source: string): string | undefined {
  return text(
    namedChildren(node).find((child) =>
      ["predefined_type", "identifier", "generic_name", "qualified_name"].includes(child.type),
    ),
    source,
  );
}

function phpType(node: TsNode, source: string): string | undefined {
  return text(
    namedChildren(node).find((child) =>
      ["primitive_type", "named_type", "qualified_name", "optional_type"].includes(child.type),
    ),
    source,
  );
}

function dartType(node: TsNode, source: string): string | undefined {
  return text(
    namedChildren(node).find((child) => ["type_identifier", "type_arguments"].includes(child.type)),
    source,
  );
}

function functionDeclaratorName(node: TsNode | null | undefined, source: string): string {
  if (!node) return "";
  const qualified = descendants(node).find((child) => child.type === "qualified_identifier");
  if (qualified) return oneLine(qualified, source);
  return text(
    descendants(node).find((child) =>
      ["identifier", "field_identifier", "type_identifier"].includes(child.type),
    ),
    source,
  );
}

function dartMethodName(node: TsNode, source: string): string {
  return (
    text(node.childForFieldName("name"), source) ||
    text(
      descendants(node).find((child) => child.type === "identifier"),
      source,
    )
  );
}

function firstMatch(source: string, pattern: RegExp): string | undefined {
  return source.match(pattern)?.[1];
}

function callSummaries(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => {
    const kind = match[1] ?? "item";
    const args = match[2] ?? "";
    const name = firstMatch(args, /\bname:\s*"([^"]+)"/) ?? firstMatch(args, /\burl:\s*"([^"]+)"/);
    if (!name) return kind;
    return `${kind} ${name.split("/").pop()}`;
  });
}

function oneLine(node: TsNode, source: string): string {
  return text(node, source).split(/\r?\n/)[0]!.trim();
}

function exportLine(node: TsNode, source: string): string {
  const unwrapped = unwrapExport(node);
  return unwrapped === node
    ? oneLine(node, source)
    : oneLine(unwrapped, source).replace(/^/, "export ");
}

function text(node: TsNode | null | undefined, source: string): string {
  if (!node) return "";
  return source.slice(node.startIndex, node.endIndex).trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizePath(path: string): string {
  return path
    .split(sep)
    .join("/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
