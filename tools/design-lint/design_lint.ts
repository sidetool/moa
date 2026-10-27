#!/usr/bin/env node
/** Read-only checks for a project's explicitly scoped CSS design system. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type ChildNode, type Declaration } from 'postcss';
import valueParser from 'postcss-value-parser';
import colorNames from 'color-name';
import fastGlob from 'fast-glob';
import { getNodeValue, parseTree, printParseErrorCode, type Node as JsonNode, type ParseError } from 'jsonc-parser';

type ValueNode = valueParser.Node;
type Severity = 'error' | 'warning';
export interface Diagnostic { rule: string; severity: Severity; file: string; line: number; column: number; message: string; suggestion?: string }
export interface LintException { file: string; property: string; value: string; reason: string }
export interface DuplicateTokenReview { value: string; tokens: Array<{ file: string; name: string }>; reason: string }
export interface SourceLintConfig {
  version: 1; include: string[]; exclude?: string[]; token_files: string[]; external_tokens?: string[];
  allowed_values?: Record<string, string[]>; exceptions?: LintException[]; tracked_files?: Record<string, string>;
  duplicate_token_reviews?: DuplicateTokenReview[];
}
export interface SourceLintReport {
  adapter: 'css'; coverage: { files: string[]; file_count: number; declarations: number };
  limitations: string[]; diagnostics: Diagnostic[]; summary: { errors: number; warnings: number }; exit_code: 0 | 1 | 2;
}
export interface SourceLintOptions { root: string; config?: string; strict?: boolean }
interface Located { file: string; node: Declaration; tokens: ValueNode[] }
interface Position { line: number; column: number }
interface ResolvedConfig { config: SourceLintConfig; files: string[]; tokenFiles: Set<string>; external: Set<string>; exceptions: Map<string, LintException>; duplicateReviews: Map<string, DuplicateTokenReview> }
const LIMITATIONS = [
  'CSS files only; templates, CSS-in-JS, preprocessors, native UI, and design files are not scanned.',
  'Token existence is project-wide, not proof of cascade, selector, theme, or runtime availability.',
  'Structural CSS parsing is not full property grammar validation or browser evaluation.',
  'Raw-value rules cover selected color, numeric geometry, typography, shadow, layer, and motion values, not every CSS keyword.',
  'Contrast, geometry, accessibility, interaction, and visual usability require separate runtime checks.',
];
const CONFIG_KEYS = new Set(['version', 'include', 'exclude', 'token_files', 'external_tokens', 'allowed_values', 'exceptions', 'tracked_files', 'duplicate_token_reviews']);
const STRUCTURAL = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'auto', 'none', 'normal', 'currentcolor', 'transparent']);
const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'device-cmyk', 'light-dark']);
const COLOR_PROPERTIES = new Set(['color', 'background', 'fill', 'stroke', 'caret-color', 'accent-color']);
const CSS_AT_RULES = new Set(['charset', 'import', 'namespace', 'media', 'supports', 'container', 'layer', 'scope', 'starting-style', 'keyframes', '-webkit-keyframes', 'font-face', 'font-feature-values', 'font-palette-values', 'page', 'counter-style', 'property', 'position-try', 'view-transition', 'top-left-corner', 'top-left', 'top-center', 'top-right', 'top-right-corner', 'bottom-left-corner', 'bottom-left', 'bottom-center', 'bottom-right', 'bottom-right-corner', 'left-top', 'left-middle', 'left-bottom', 'right-top', 'right-middle', 'right-bottom']);
const SYSTEM_COLORS = new Set(['accentcolor', 'accentcolortext', 'activetext', 'buttonborder', 'buttonface', 'buttontext', 'canvas', 'canvastext', 'field', 'fieldtext', 'graytext', 'highlight', 'highlighttext', 'linktext', 'mark', 'marktext', 'selecteditem', 'selecteditemtext', 'visitedtext']);
const SIZE_PROPERTIES = new Set(['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size', 'flex-basis']);
const SPACING_PROPERTIES = new Set(['top', 'right', 'bottom', 'left', 'gap', 'row-gap', 'column-gap', 'border-spacing', 'outline-offset', 'text-indent', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset']);
const TYPE_PROPERTIES = new Set(['font', 'font-family', 'font-size', 'font-weight', 'font-stretch', 'font-width', 'line-height', 'letter-spacing', 'word-spacing']);
const MOTION_PROPERTIES = new Set(['transform', 'translate', 'rotate', 'scale', 'perspective']);
const PROPERTY_NAME = /^(?:--(?:[A-Za-z0-9_-]|[^\x00-\x7F])+|-?[a-z][a-z0-9-]*)$/;
const TOKEN_NAME = /^--(?:[A-Za-z0-9_-]|[^\x00-\x7F])+$/;
class ConfigurationError extends Error {}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function readUtf8(file: string): string { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)); }
function relativePath(value: unknown, label: string, glob = false): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigurationError(`${label} must be a non-empty relative path.`);
  if (path.posix.isAbsolute(value) || value.includes('\\') || value.includes(':') || value.split('/').some(part => ['', '.', '..'].includes(part))) throw new ConfigurationError(`${label} must stay inside the project root: ${value}`);
  if (!glob && /[*?\[\]]/.test(value)) throw new ConfigurationError(`${label} cannot contain wildcards: ${value}`);
}
function safeFile(root: string, relative: string, label: string): string {
  relativePath(relative, label);
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new ConfigurationError(`${label} cannot use a symlink: ${relative}`);
  }
  const fromRoot = path.relative(root, realpathSync(cursor));
  if (!statSync(cursor).isFile() || fromRoot.startsWith(`..${path.sep}`) || fromRoot === '..' || path.isAbsolute(fromRoot)) throw new ConfigurationError(`${label} must be an existing file inside the root: ${relative}`);
  return cursor;
}
function stringList(config: Record<string, unknown>, key: string, required = false): string[] {
  const value = config[key] === undefined ? [] : config[key];
  if (!Array.isArray(value) || (required && !value.length) || value.some(item => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) throw new ConfigurationError(`${key} must be a ${required ? 'non-empty ' : ''}list of unique strings.`);
  return value as string[];
}
function expandGlobs(root: string, patterns: string[], label: string, requireMatches = true): Set<string> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    relativePath(pattern, label, true);
    if (pattern.startsWith('!')) throw new ConfigurationError(`${label} cannot contain negated patterns; use exclude.`);
    const matches = fastGlob.sync(pattern, { cwd: root, onlyFiles: false, dot: true, followSymbolicLinks: false, suppressErrors: false });
    if (requireMatches && !matches.length) throw new ConfigurationError(`${label} pattern matches no files: ${pattern}`);
    for (const relative of matches) {
      const extension = path.extname(relative).toLowerCase();
      if (label === 'exclude' && (lstatSync(path.join(root, relative)).isDirectory() || extension !== '.css')) continue;
      safeFile(root, relative, label);
      if (extension !== '.css') throw new ConfigurationError(`${label} matched an unsupported non-CSS file: ${relative}`);
      files.add(relative);
    }
  }
  return files;
}
function withoutComments(nodes: ValueNode[]): ValueNode[] { return nodes.filter(node => node.type !== 'comment').map(node => node.type === 'function' ? { ...node, nodes: withoutComments(node.nodes) } : node); }
function normalizeValue(value: string): string { return valueParser.stringify(withoutComments(valueParser(value).nodes)).trim(); }
function parseConfigJson(source: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false });
  if (errors.length || !tree) throw new ConfigurationError(`Invalid JSON: ${errors.map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(', ') || 'empty document'}`);
  const check = (node: JsonNode): void => {
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key: unknown = property.children?.[0]?.value;
        if (typeof key !== 'string') throw new ConfigurationError('Invalid JSON object key.');
        if (keys.has(key)) throw new ConfigurationError(`Duplicate JSON key: ${key}`);
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) check(child);
  };
  check(tree);
  return getNodeValue(tree) as unknown;
}
function exceptionKey(file: string, prop: string, value: string): string { return JSON.stringify([file, prop, value]); }
function duplicateReviewKey(value: string, tokens: DuplicateTokenReview['tokens']): string {
  return JSON.stringify([normalizeValue(value), [...new Set(tokens.map(token => JSON.stringify([token.file, token.name])))].sort()]);
}
function readConfig(root: string, configPath: string): ResolvedConfig {
  const unknownConfig = parseConfigJson(readUtf8(safeFile(root, configPath, 'config')));
  if (!record(unknownConfig) || Object.keys(unknownConfig).some(key => !CONFIG_KEYS.has(key))) throw new ConfigurationError('Config must be an object with only documented keys.');
  if (unknownConfig.version !== 1) throw new ConfigurationError('Config version must be the integer 1.');
  const include = stringList(unknownConfig, 'include', true);
  const exclude = stringList(unknownConfig, 'exclude');
  const included = expandGlobs(root, include, 'include');
  const excluded = expandGlobs(root, exclude, 'exclude', false);
  const files = [...included].filter(file => !excluded.has(file)).sort();
  if (!files.length) throw new ConfigurationError('No CSS files remain after exclusions; empty coverage cannot pass.');
  const tokenPatterns = stringList(unknownConfig, 'token_files', true);
  const tokenFiles = expandGlobs(root, tokenPatterns, 'token_files');
  if ([...tokenFiles].some(file => !files.includes(file))) throw new ConfigurationError('Every token file must be included and must not be excluded.');
  const externalTokens = stringList(unknownConfig, 'external_tokens');
  if (externalTokens.some(token => !TOKEN_NAME.test(token))) throw new ConfigurationError('external_tokens entries must be custom property names starting with --.');
  const allowed = unknownConfig.allowed_values === undefined ? {} : unknownConfig.allowed_values;
  if (!record(allowed)) throw new ConfigurationError('allowed_values must map CSS properties to arrays of exact values.');
  const allowedValues: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [prop, values] of Object.entries(allowed)) {
    if (!PROPERTY_NAME.test(prop)) throw new ConfigurationError(`Invalid allowed_values property: ${prop}`);
    allowedValues[prop] = stringList({ [prop]: values }, prop);
  }
  const unknownExceptions = unknownConfig.exceptions === undefined ? [] : unknownConfig.exceptions;
  if (!Array.isArray(unknownExceptions)) throw new ConfigurationError('exceptions must be a list.');
  const exceptions = new Map<string, LintException>();
  for (const entry of unknownExceptions as unknown[]) {
    if (!record(entry) || Object.keys(entry).sort().join(',') !== 'file,property,reason,value' || Object.values(entry).some(value => typeof value !== 'string' || !value.trim())) throw new ConfigurationError('Each exception requires exactly non-empty file, property, value, and reason strings.');
    const exception = entry as unknown as LintException;
    relativePath(exception.file, 'exception file');
    if (!files.includes(exception.file) || !PROPERTY_NAME.test(exception.property)) throw new ConfigurationError('Exception files must be scanned files and properties must be valid names.');
    const key = exceptionKey(exception.file, exception.property, normalizeValue(exception.value));
    if (exceptions.has(key)) throw new ConfigurationError('Duplicate exception for the same file, property, and value.');
    exceptions.set(key, exception);
  }
  const unknownReviews = unknownConfig.duplicate_token_reviews === undefined ? [] : unknownConfig.duplicate_token_reviews;
  if (!Array.isArray(unknownReviews)) throw new ConfigurationError('duplicate_token_reviews must be a list.');
  const duplicateReviews = new Map<string, DuplicateTokenReview>();
  for (const entry of unknownReviews as unknown[]) {
    if (!record(entry) || Object.keys(entry).sort().join(',') !== 'reason,tokens,value' || typeof entry.value !== 'string' || !normalizeValue(entry.value) || typeof entry.reason !== 'string' || !entry.reason.trim() || !Array.isArray(entry.tokens) || entry.tokens.length < 2) throw new ConfigurationError('Each duplicate token review requires an exact non-empty value, at least two tokens, and a reason.');
    const names = new Set<string>();
    const locations = new Set<string>();
    for (const token of entry.tokens as unknown[]) {
      if (!record(token) || Object.keys(token).sort().join(',') !== 'file,name' || typeof token.file !== 'string' || typeof token.name !== 'string' || !TOKEN_NAME.test(token.name)) throw new ConfigurationError('Reviewed tokens require exactly file and custom-property name strings.');
      relativePath(token.file, 'reviewed token file');
      const location = JSON.stringify([token.file, token.name]);
      if (!tokenFiles.has(token.file) || locations.has(location)) throw new ConfigurationError('Reviewed tokens must have distinct file/name pairs and belong to included canonical token files.');
      names.add(token.name);
      locations.add(location);
    }
    if (names.size < 2) throw new ConfigurationError('A duplicate token review requires at least two distinct token names.');
    const review = entry as unknown as DuplicateTokenReview;
    const key = duplicateReviewKey(review.value, review.tokens);
    if (duplicateReviews.has(key)) throw new ConfigurationError('Duplicate review for the same token group and value.');
    duplicateReviews.set(key, review);
  }
  const unknownTracked = unknownConfig.tracked_files === undefined ? {} : unknownConfig.tracked_files;
  if (!record(unknownTracked)) throw new ConfigurationError('tracked_files must map relative paths to SHA-256 digests.');
  const trackedFiles: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [relative, digest] of Object.entries(unknownTracked)) {
    safeFile(root, relative, 'tracked file');
    if (typeof digest !== 'string' || !/^[a-fA-F0-9]{64}$/.test(digest)) throw new ConfigurationError(`Invalid SHA-256 digest for tracked file: ${relative}`);
    trackedFiles[relative] = digest;
  }
  return { config: { version: 1, include, exclude, token_files: tokenPatterns, external_tokens: externalTokens, allowed_values: allowedValues, exceptions: [...exceptions.values()], tracked_files: trackedFiles, duplicate_token_reviews: [...duplicateReviews.values()] }, files, tokenFiles, external: new Set(externalTokens), exceptions, duplicateReviews };
}
function compact(nodes: ValueNode[]): ValueNode[] { return nodes.filter(node => node.type !== 'space' && node.type !== 'comment'); }
function coveredLocalImport(file: string, params: string, files: string[]): boolean {
  const nodes = compact(valueParser(params).nodes);
  if (nodes.length !== 1) return false;
  let target = nodes[0];
  if (target.type === 'function') {
    if (target.value.toLowerCase() !== 'url' || target.unclosed) return false;
    const url = valueParser(`url(${valueParser.stringify(target.nodes)})`).nodes[0];
    if (url.type !== 'function' || url.unclosed) return false;
    const children = compact(url.nodes);
    if (children.length !== 1) return false;
    target = children[0];
    if (target.type === 'word' && /[\s()"']/.test(target.value)) return false;
  } else if (target.type !== 'string') return false;
  if ((target.type !== 'string' && target.type !== 'word') || ('unclosed' in target && target.unclosed)) return false;
  const reference = target.value;
  if (!reference || /[\\:%?#\x00-\x1F\x7F]/.test(reference) || path.posix.isAbsolute(reference)) return false;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference));
  if (relative === '..' || relative.startsWith('../') || path.posix.extname(relative).toLowerCase() !== '.css') return false;
  return files.includes(relative);
}
function variableParts(node: valueParser.FunctionNode): { name: string | null; fallback: ValueNode[] } {
  const args = compact(node.nodes);
  const first = args[0];
  if (!first || first.type !== 'word' || !TOKEN_NAME.test(first.value)) return { name: null, fallback: [] };
  if (args.length === 1) return { name: first.value, fallback: [] };
  if (args[1]?.type !== 'div' || args[1].value !== ',') return { name: null, fallback: [] };
  return { name: first.value, fallback: args.slice(2) };
}
function* variableReferences(nodes: ValueNode[]): Generator<{ name: string | null; node: ValueNode }> {
  for (const node of nodes) {
    if (node.type !== 'function' || node.value.toLowerCase() === 'url') continue;
    if (node.value.toLowerCase() === 'var') {
      const parts = variableParts(node);
      yield { name: parts.name, node };
      yield* variableReferences(parts.fallback);
    } else yield* variableReferences(node.nodes);
  }
}
function governed(prop: string): boolean {
  return [COLOR_PROPERTIES, SIZE_PROPERTIES, SPACING_PROPERTIES, TYPE_PROPERTIES, MOTION_PROPERTIES].some(set => set.has(prop)) || ['box-shadow', 'text-shadow', 'z-index', 'opacity', 'fill-opacity', 'stroke-opacity'].includes(prop) || prop.endsWith('-color') || /^(margin|padding|inset|border|outline|background|scroll-margin|scroll-padding|animation|transition)/.test(prop);
}
function hasRawValue(prop: string, nodes: ValueNode[], colorChannels = false): boolean {
  for (const node of nodes) {
    if (node.type === 'space' || node.type === 'comment' || node.type === 'div') continue;
    if (node.type === 'function') {
      const name = node.value.toLowerCase();
      if (name === 'url') continue;
      if (name === 'var') { if (hasRawValue(prop, variableParts(node).fallback, colorChannels)) return true; }
      else if (COLOR_FUNCTIONS.has(name)) { if (![...variableReferences(node.nodes)].length || hasRawValue(prop, node.nodes, true)) return true; }
      else if (['cubic-bezier', 'steps', 'linear'].includes(name) && ![...variableReferences(node.nodes)].length) return true;
      else if (hasRawValue(prop, node.nodes, colorChannels)) return true;
      continue;
    }
    if (node.type === 'string') { if (prop === 'font' || prop === 'font-family') return true; continue; }
    if (node.type !== 'word') continue;
    const value = node.value.toLowerCase();
    const dimension = valueParser.unit(value);
    if (dimension) {
      const number = Number(dimension.number);
      if (number === 0 && !colorChannels) continue;
      if (number === 100 && dimension.unit === '%' && SIZE_PROPERTIES.has(prop)) continue;
      if (number === 1 && dimension.unit === '' && ['opacity', 'fill-opacity', 'stroke-opacity', 'scale'].includes(prop)) continue;
      return true;
    }
    if (value.startsWith('#')) return true;
    if (STRUCTURAL.has(value) || /^[+*/-]$/.test(value)) continue;
    const colorProperty = COLOR_PROPERTIES.has(prop) || /-(color|shadow)$/.test(prop) || /^(border|outline|background)/.test(prop);
    if (colorProperty && (Object.hasOwn(colorNames, value) || SYSTEM_COLORS.has(value))) return true;
    if (['font', 'font-family', 'font-size', 'font-weight', 'font-stretch', 'font-width'].includes(prop)) return true;
    if (['transition-timing-function', 'animation-timing-function'].includes(prop)) return true;
    if (['transition', 'animation'].includes(prop) && ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end'].includes(value)) return true;
    if (/^(border|outline)/.test(prop) && ['thin', 'medium', 'thick'].includes(value)) return true;
  }
  return false;
}
function position(node?: ChildNode): Position { return { line: node?.source?.start?.line ?? 1, column: node?.source?.start?.column ?? 1 }; }
function sourceValue(node: Declaration): string { return node.raws.value?.value === node.value ? node.raws.value.raw : node.value; }
function tokenPosition(declaration: Declaration, token: ValueNode): Position {
  const prefix = declaration.prop + (declaration.raws.between ?? ':') + sourceValue(declaration).slice(0, token.sourceIndex);
  const lines = prefix.split('\n');
  const start = position(declaration);
  return { line: start.line + lines.length - 1, column: lines.length === 1 ? start.column + prefix.length : (lines.at(-1)?.length ?? 0) + 1 };
}
class Linter {
  readonly diagnostics: Diagnostic[] = [];
  readonly declarations: Located[] = [];
  private readonly definitions = new Map<string, Located[]>();
  private readonly usedExceptions = new Set<string>();
  private readonly usedDuplicateReviews = new Set<string>();
  private readonly reportedExternal = new Set<string>();
  constructor(private root: string, private configPath: string, private scope: ResolvedConfig) {}
  private report(rule: string, severity: Severity, file: string, at: Position | undefined, message: string, suggestion?: string): void {
    this.diagnostics.push({ rule, severity, file, line: at?.line ?? 1, column: at?.column ?? 1, message, ...(suggestion ? { suggestion } : {}) });
  }
  private inspectValues(file: string, declaration: Declaration, nodes: ValueNode[]): void {
    const ignored: Array<[number, number]> = [];
    let escaped = declaration.prop.includes('\\');
    const inspect = (children: ValueNode[]): void => {
      for (const token of children) {
        if (token.type === 'string' || token.type === 'comment' || (token.type === 'function' && token.value.toLowerCase() === 'url')) {
          ignored.push([token.sourceIndex, token.sourceEndIndex]);
          continue;
        }
        if ((token.type === 'word' || token.type === 'function') && token.value.includes('\\')) escaped = true;
        if (token.type === 'function') inspect(token.nodes);
      }
    };
    inspect(nodes);
    if (escaped) this.report('escaped-identifier-coverage', 'warning', file, position(declaration), 'Escaped CSS identifiers are not decoded by this adapter; property, token, and raw-value coverage may be incomplete.', 'Review the equivalent unescaped spelling or use a CSS-aware adapter that resolves escapes; strict mode fails on this warning.');
    const value = sourceValue(declaration);
    const stack: string[] = [];
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    for (let index = 0; index < value.length; index++) {
      const skip = ignored.find(([start]) => start === index);
      if (skip) { index = skip[1] - 1; continue; }
      const character = value[index];
      if (character === '\\') { index++; continue; }
      if ('([{'.includes(character)) stack.push(character);
      else if (Object.hasOwn(pairs, character) && stack.pop() !== pairs[character]) {
        this.report('css-parse', 'error', file, position(declaration), `Unmatched CSS closing delimiter ${character}.`);
        return;
      }
    }
    if (stack.length) this.report('css-parse', 'error', file, position(declaration), 'Unclosed CSS delimiter.');
    for (const node of nodes) {
      if ('unclosed' in node && node.unclosed) this.report('css-parse', 'error', file, tokenPosition(declaration, node), `Unclosed CSS ${node.type}.`);
    }
  }
  private parse(file: string): void {
    const source = readUtf8(safeFile(this.root, file, 'input'));
    try {
      const tree = postcss.parse(source, { from: file });
      tree.walk(node => {
        if (node.type === 'decl') {
          const tokens = valueParser(sourceValue(node)).nodes;
          const located = { file, node, tokens };
          this.declarations.push(located);
          this.inspectValues(file, node, tokens);
          if (node.prop.startsWith('--') && this.scope.tokenFiles.has(file)) {
            const definitions = this.definitions.get(node.prop) ?? [];
            definitions.push(located);
            this.definitions.set(node.prop, definitions);
          }
        } else if (node.type === 'atrule') {
          const name = node.name.toLowerCase();
          if (name === 'import' && (node.parent?.type !== 'root' || node.nodes !== undefined || !coveredLocalImport(file, node.params, this.scope.files))) this.report('import-coverage', 'warning', file, position(node), 'This @import is not a simple local CSS reference covered by the explicit scan; its source coverage is not established.', 'Include every owned imported CSS file explicitly. External, conditional, escaped, encoded, malformed, or query/fragment imports require separate verification; imports are never fetched and their cascade is not evaluated.');
          if (!CSS_AT_RULES.has(name)) this.report('at-rule-coverage', 'warning', file, position(node), `@${node.name} is not a recognized standard CSS rule; generated or extension behavior is not verified.`, "Check the compiled CSS and use the project's compiler or adapter for extension syntax.");
          if (name === 'property') this.report('registration-coverage', 'warning', file, position(node), '@property registration and initial-value semantics are not evaluated; canonical declarations are still required.');
        }
      });
    } catch (error) {
      if (!(error instanceof postcss.CssSyntaxError)) throw error;
      this.report('css-parse', 'error', file, { line: error.line ?? 1, column: error.column ?? 1 }, error.reason);
    }
  }
  private checkDeclaration({ file, node, tokens }: Located): void {
    const name = node.prop.startsWith('--') ? node.prop : node.prop.toLowerCase();
    const value = normalizeValue(sourceValue(node));
    for (const { name: reference, node: token } of variableReferences(tokens)) {
      if (reference === null) this.report('invalid-variable', 'error', file, tokenPosition(node, token), 'Malformed var(); expected a custom property name and optional comma-separated fallback.');
      else if (this.scope.external.has(reference)) {
        if (!this.reportedExternal.has(reference)) { this.reportedExternal.add(reference); this.report('external-token-coverage', 'warning', file, tokenPosition(node, token), `${reference} is declared external; its definition and runtime availability are not verified.`); }
      } else if (!this.definitions.has(reference)) this.report('undefined-token', 'error', file, tokenPosition(node, token), `${reference} has no definition in the declared canonical token files.`);
    }
    if (name.startsWith('--')) {
      if (!this.scope.tokenFiles.has(file)) this.report('unmanaged-token', 'error', file, position(node), `${name} is defined outside the canonical token files.`, 'Move shared tokens into the canonical source, or explicitly scope the canonical file in config.');
      return;
    }
    const standardName = name.replace(/^-(webkit|moz|ms|o)-/, '');
    if (!governed(standardName) || !hasRawValue(standardName, tokens)) return;
    if ((this.scope.config.allowed_values?.[name] ?? []).some(item => normalizeValue(item) === value)) return;
    const exception = exceptionKey(file, name, value);
    if (this.scope.exceptions.has(exception)) { this.usedExceptions.add(exception); return; }
    const candidates = [...this.definitions].filter(([, definitions]) => definitions.some(definition => normalizeValue(sourceValue(definition.node)) === value)).map(([token]) => token).sort();
    let suggestion = 'Use a declared token, or document an intentional exact literal in allowed_values or exceptions.';
    if (candidates.length) suggestion += ` Exact-value candidates (confirm semantic role before use): ${candidates.join(', ')}.`;
    this.report('raw-design-value', 'error', file, position(node), `${name}: ${value} contains an unmanaged design value.`, suggestion);
  }
  private checkAliases(): void {
    const unique = new Map<string, Located>();
    const graph = new Map<string, Set<string>>();
    for (const [name, definitions] of this.definitions) {
      const first = definitions[0];
      if (new Set(definitions.map(definition => normalizeValue(sourceValue(definition.node)))).size === 1) unique.set(name, first);
      const dependencies = definitions.map(definition => [...new Set([...variableReferences(definition.tokens)].flatMap(reference => reference.name === null ? [] : [reference.name]))].sort());
      if (new Set(dependencies.map(references => JSON.stringify(references))).size > 1) this.report('ambiguous-token', 'warning', first.file, position(first.node), `${name} has different alias dependencies across scopes or themes; alias-cycle proof is skipped for this token.`, 'Check each supported theme and selector in the running app.');
      else graph.set(name, new Set(dependencies[0]));
    }
    const state = new Map<string, 1 | 2>();
    const stack: string[] = [];
    const reported = new Set<string>();
    const visit = (name: string): void => {
      state.set(name, 1); stack.push(name);
      for (const target of [...(graph.get(name) ?? [])].sort()) {
        if (!graph.has(target)) continue;
        if (state.get(target) === 1) {
          const cycle = [...stack.slice(stack.indexOf(target)), target];
          const key = JSON.stringify([...new Set(cycle)].sort());
          if (!reported.has(key)) {
            reported.add(key);
            const definition = this.definitions.get(name)?.[0];
            if (definition) this.report('token-cycle', 'error', definition.file, position(definition.node), `Canonical token alias cycle: ${cycle.join(' -> ')}`);
          }
        } else if (!state.has(target)) visit(target);
      }
      stack.pop(); state.set(name, 2);
    };
    for (const name of [...graph.keys()].sort()) if (!state.has(name)) visit(name);
    const values = new Map<string, Array<{ name: string; definition: Located }>>();
    for (const [name, definition] of unique) {
      if ([...variableReferences(definition.tokens)].length) continue;
      const value = normalizeValue(sourceValue(definition.node));
      const previous = values.get(value) ?? [];
      previous.push({ name, definition }); values.set(value, previous);
    }
    for (const [value, definitions] of values) {
      if (definitions.length < 2) continue;
      const key = duplicateReviewKey(value, definitions.flatMap(({ name }) => this.definitions.get(name)!.map(definition => ({ name, file: definition.file }))));
      if (this.scope.duplicateReviews.has(key)) { this.usedDuplicateReviews.add(key); continue; }
      const first = definitions[0].definition;
      this.report('duplicate-token-value', 'warning', first.file, position(first.node), `Canonical tokens share the exact value ${JSON.stringify(value)}: ${definitions.map(item => item.name).join(', ')}.`, 'Confirm distinct semantic roles; equal values alone do not justify merging tokens. Record an intentional complete group in duplicate_token_reviews with its exact value, token files/names, and reason.');
    }
  }
  run(): Diagnostic[] {
    for (const file of this.scope.files) this.parse(file);
    for (const declaration of this.declarations) this.checkDeclaration(declaration);
    this.checkAliases();
    for (const [key, review] of this.scope.duplicateReviews) if (!this.usedDuplicateReviews.has(key)) this.report('unused-duplicate-token-review', 'warning', this.configPath, undefined, `No duplicate token group matches the reviewed value and complete token list: ${review.value}, ${review.tokens.map(token => token.name).join(', ')}.`, 'Review changed values, token ownership, or group membership and remove or update the stale review.');
    for (const [key, exception] of this.scope.exceptions) if (!this.usedExceptions.has(key)) this.report('unused-exception', 'warning', this.configPath, undefined, `Exception was not needed by any raw-value finding: ${exception.file}, ${exception.property}: ${normalizeValue(exception.value)}.`, 'Remove stale exceptions or verify that the intended file is covered.');
    for (const [file, expected] of Object.entries(this.scope.config.tracked_files ?? {})) {
      const actual = createHash('sha256').update(readFileSync(safeFile(this.root, file, 'tracked file'))).digest('hex');
      if (actual !== expected.toLowerCase()) this.report('tracked-file-drift', 'warning', file, undefined, 'File bytes differ from the recorded SHA-256 baseline.', 'Review the implementation and spec together before accepting a new baseline.');
    }
    if (!this.declarations.length) this.report('empty-declarations', 'error', this.configPath, undefined, 'The selected CSS contains no declarations; empty checks cannot establish coverage.');
    this.diagnostics.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule));
    return this.diagnostics;
  }
}
export function runDesignLint(options: SourceLintOptions): SourceLintReport {
  const result: SourceLintReport = { adapter: 'css', coverage: { files: [], file_count: 0, declarations: 0 }, limitations: [...LIMITATIONS], diagnostics: [], summary: { errors: 0, warnings: 0 }, exit_code: 0 };
  const configPath = options.config ?? 'spec/design-system/lint.json';
  try {
    const inputRoot = options.root === '~' ? homedir() : options.root.startsWith('~/') ? path.join(homedir(), options.root.slice(2)) : options.root;
    const root = realpathSync(inputRoot);
    if (!statSync(root).isDirectory()) throw new ConfigurationError('--root must be an existing directory.');
    const scope = readConfig(root, configPath);
    const linter = new Linter(root, configPath, scope);
    result.diagnostics = linter.run();
    result.coverage = { files: scope.files, file_count: scope.files.length, declarations: linter.declarations.length };
    if (result.diagnostics.some(item => ['css-parse', 'empty-declarations'].includes(item.rule))) result.exit_code = 2;
  } catch (error) {
    result.diagnostics.push({ rule: 'configuration', severity: 'error', file: configPath, line: 1, column: 1, message: errorMessage(error) });
    result.exit_code = 2;
  }
  result.summary.errors = result.diagnostics.filter(item => item.severity === 'error').length;
  result.summary.warnings = result.diagnostics.filter(item => item.severity === 'warning').length;
  if (result.exit_code === 0 && (result.summary.errors > 0 || (options.strict && result.summary.warnings > 0))) result.exit_code = 1;
  return result;
}
function emit(result: SourceLintReport, format: 'text' | 'json'): void {
  if (format === 'json') { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return; }
  process.stdout.write(`CSS design lint: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s); ${result.coverage.file_count} file(s), ${result.coverage.declarations} declaration(s).\n`);
  for (const item of result.diagnostics) {
    process.stdout.write(`${item.file}:${item.line}:${item.column}: ${item.severity} [${item.rule}] ${item.message}\n`);
    if (item.suggestion) process.stdout.write(`  ${item.suggestion}\n`);
  }
  process.stdout.write(`Coverage limits:\n${result.limitations.map(limit => `  - ${limit}\n`).join('')}`);
}
export function main(argv: string[] = process.argv.slice(2)): number {
  let root: string | undefined;
  let config: string | undefined;
  let format: 'text' | 'json' = 'text';
  let strict = false;
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === '--help' || arg === '-h') {
        process.stdout.write('Usage: tsx design_lint.ts --root PATH [--config spec/design-system/lint.json] [--format text|json] [--strict]\nRead-only checks for explicitly scoped CSS. --strict also fails on warnings.\n'); return 0;
      }
      if (arg === '--strict') { strict = true; continue; }
      if (!['--root', '--config', '--format'].includes(arg)) throw new ConfigurationError(`Unknown option: ${arg}`);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new ConfigurationError(`Missing value for ${arg}.`);
      if (arg === '--root') root = value;
      else if (arg === '--config') config = value;
      else if (value === 'text' || value === 'json') format = value;
      else throw new ConfigurationError('--format must be text or json.');
    }
    if (!root) throw new ConfigurationError('--root is required.');
  } catch (error) { process.stderr.write(`CSS design lint: ${errorMessage(error)}\n`); return 2; }
  const result = runDesignLint({ root, config, strict });
  emit(result, format);
  return result.exit_code;
}
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) process.exitCode = main();
