/** 类型声明：scripts/i18n/i18n-checks.mjs（仅用于测试与类型检查，运行时为纯 JS） */

export interface LocaleTree {
  [key: string]: string | LocaleTree;
}

export interface LoadedLocale {
  label: string;
  tree: LocaleTree;
}

export interface LocaleWithTree {
  code: string;
  tree: LocaleTree;
}

export interface LocaleWithLeaves {
  code: string;
  leaves: Record<string, string>;
}

export interface KeyParityItem {
  locale: string;
  key: string;
}

export interface KeyTypeMismatch extends KeyParityItem {
  ref: "object" | "leaf";
  actual: "object" | "leaf";
}

export interface KeyParityResult {
  missing: KeyParityItem[];
  extra: KeyParityItem[];
  typeMismatch: KeyTypeMismatch[];
}

export interface PlaceholderMismatch {
  locale: string;
  key: string;
  missing: string[];
  extra: string[];
}

export interface SuspiciousBraces {
  locale: string;
  key: string;
  text: string;
}

export interface PlaceholderResult {
  mismatches: PlaceholderMismatch[];
  suspicious: SuspiciousBraces[];
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface StaticReference {
  file: string;
  line: number;
  key: string;
  kind: string;
}

export interface DynamicReference {
  file: string;
  line: number;
  kind: string;
  expr: string;
}

export interface ReferenceScan {
  static: StaticReference[];
  dynamic: DynamicReference[];
}

export interface ValidateResult {
  invalid: StaticReference[];
  uniqueKeys: number;
}

export interface RustSite {
  file: string;
  line: number;
}

export interface RustLiteralSite extends RustSite {
  code: string;
  logContext: boolean;
}

export interface RustVariableSite extends RustSite {
  variable: string;
}

export interface RustProtocolFormat extends RustSite {
  builder: boolean;
}

export interface RustNestedHint extends RustSite {
  param: string;
  variable: string;
}

export interface RustFacts {
  literalSites: RustLiteralSite[];
  protocolLiterals: (RustSite & { code: string })[];
  protocolFormats: RustProtocolFormat[];
  variableSites: RustVariableSite[];
  dottedLiterals: Set<string>;
  dottedLiteralsByFile: Map<string, Set<string>>;
  nestedHints: RustNestedHint[];
}

export interface LocaleOnlyItem {
  code: string;
  reason: "frontend" | "rust-literal" | "variable" | "unconfirmed";
}

export interface FrontendIssue {
  code: string;
  kind: "sentinel" | "unbacked";
  inRust: boolean;
}

export interface VariableSiteWithCandidates extends RustVariableSite {
  candidates: string[];
}

export interface RustCoverageResult {
  prefixes: string[];
  required: string[];
  missing: { code: string; sites: RustSite[] }[];
  frontendIssues: FrontendIssue[];
  internalOnly: { code: string; sites: RustSite[] }[];
  localeOnly: LocaleOnlyItem[];
  nested: RustNestedHint[];
  protocolFormats: RustProtocolFormat[];
  variableSites: VariableSiteWithCandidates[];
  stats: {
    rustCodes: number;
    localeCodes: number;
    literalSites: number;
    protocolLiterals: number;
    variableSites: number;
  };
}

export function loadLocaleModule(filePath: string): LoadedLocale;
export function flattenLeaves(tree: LocaleTree): Record<string, string>;
export function nodeKinds(tree: LocaleTree): Record<string, "object" | "leaf">;
export function checkKeyParity(
  refCode: string,
  refTree: LocaleTree,
  others: LocaleWithTree[],
): KeyParityResult;
export function extractPlaceholders(text: string): string[];
export function hasSuspiciousBraces(text: string): boolean;
export function checkPlaceholders(
  refCode: string,
  refLeaves: Record<string, string>,
  others: LocaleWithLeaves[],
): PlaceholderResult;
export function maskComments(source: string): string;
export function collectReferences(files: SourceFile[], namespaces: string[]): ReferenceScan;
export function validateReferences(refLeaves: Record<string, string>, refs: StaticReference[]): ValidateResult;
export function stripRustTestModules(source: string): string;
export function collectRustFacts(sources: SourceFile[]): RustFacts;
export function collectFrontendProtocolCodes(files: SourceFile[]): string[];
export function checkRustCoverage(
  refLeaves: Record<string, string>,
  facts: RustFacts,
  frontendCodes: string[],
): RustCoverageResult;

export interface VariableWhitelistEntry {
  file: string;
  variable: string;
  reason: string;
  codes: string[];
}

export interface VariableWhitelistProblem {
  kind: "staleSite" | "codeNotInFile" | "missingTranslation";
  file: string;
  code?: string;
  variable?: string;
  detail: string;
}

export interface VariableWhitelistResult {
  problems: VariableWhitelistProblem[];
  coveredSites: { file: string; variable: string; sites: RustVariableSite[]; codes: string[] }[];
  uncoveredSites: RustVariableSite[];
  whitelistSize: number;
}

export const VARIABLE_EMISSION_WHITELIST: VariableWhitelistEntry[];
export function checkVariableWhitelist(
  refLeaves: Record<string, string>,
  facts: RustFacts,
  whitelist?: VariableWhitelistEntry[],
): VariableWhitelistResult;
