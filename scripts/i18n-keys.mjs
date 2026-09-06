#!/usr/bin/env node
/**
 * What the interface can show, read from the source, checked against the
 * message tables in lib/i18n-messages.
 *
 * Two kinds of reference exist. A dotted key is the first argument of t() or
 * translate(); TypeScript already refuses one that is not in the English
 * table. An English sentence is copy that reaches the screen as data and is
 * translated by value with tx(): a toast, a validation message, the argument
 * of confirm() or alert(), an Error message, the `error` an API route hands
 * back, a sentence the database raises. Every one of those must be the
 * English text of some key, or it is shown untranslated.
 *
 * Run it to see what is missing or no longer referenced:
 *
 *   node scripts/i18n-keys.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SOURCE_DIRS = ["app", "components", "lib"];

/** Functions whose argument at the given index is shown to a member as English text. */
const SENTENCE_SINKS = new Map([
  ["tx", 0], ["setToast", 0], ["confirm", 0], ["alert", 0], ["prompt", 0],
  ["need", 1], ["invalid", 1],
  ["setOnboardingError", 0], ["setCampaignFeedback", 0], ["setListingFeedback", 0],
  ["setCropError", 0], ["setDeleteAccountError", 0], ["setLocationError", 0],
]);
/** Functions whose argument is a [message, field] tuple. */
const TUPLE_SINKS = new Set(["reportMissing"]);
/** Functions whose returned string literals are shown to a member. */
const RETURNING_SINKS = new Set(["friendlyDbError"]);
/** Brand and product names never translate; a symbol or an abbreviation is not a sentence. */
const SKIP = new Set(["SideSpace", "Stripe", "Instagram", "TikTok", "YouTube", "Google", "Supabase", "Vercel", "Slack"]);

const isSentence = (text) => /[A-Za-z]/.test(text) && text.trim().length > 1 && !(text.length <= 3 && !/[a-z]/.test(text)) && !SKIP.has(text);
/** A sentence naming an environment variable is for whoever deploys the site, not for a member. */
const isOperatorMessage = (text) => /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(text);

export function listSourceFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "i18n-messages") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  return out.sort();
}

function literals(node, into) {
  if (!node) return;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return literals(node.expression, into);
  if (ts.isConditionalExpression(node)) { literals(node.whenTrue, into); literals(node.whenFalse, into); return; }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) { literals(node.left, into); literals(node.right, into); }
    else if (kind === ts.SyntaxKind.AmpersandAmpersandToken) literals(node.right, into);
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { if (isSentence(node.text) && !isOperatorMessage(node.text)) into.add(node.text); }
}

/** Property names under which a module-level constant carries copy the interface shows through tx(). */
const MODULE_DISPLAY_PROPS = new Set(["label", "short", "eyebrow", "sentence", "hint", "example", "help", "beforeAlt", "afterAlt", "imageAlt", "unit", "title", "description", "text", "heading", "subtitle", "caption", "summary", "blurb", "body", "placeholder", "cta", "question", "answer", "note", "detail", "helper", "lead", "tagline", "kicker", "headline", "tooltip", "badge", "empty", "action", "copy", "message", "prefix", "suffix", "name", "examples", "sentences", "hints", "labels", "lines", "bullets", "points", "items", "alt"]);
const displayLike = (text) => /[A-Za-z]/.test(text) && (/\s/.test(text) || /^[A-Z]/.test(text));

/** Copy held in module-level constants: option labels, chip lists, demo content. */
function moduleLevelSentences(node, into, top) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isParenthesizedExpression(node)) return moduleLevelSentences(node.expression, into, top);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { if (top && displayLike(node.text) && isSentence(node.text)) into.add(node.text); return; }
  if (ts.isArrayLiteralExpression(node)) { for (const element of node.elements) { if ((ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) && displayLike(element.text) && isSentence(element.text)) into.add(element.text); else moduleLevelSentences(element, into, false); } return; }
  if (ts.isObjectLiteralExpression(node)) {
    const strings = node.properties.filter((property) => ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)));
    const allDisplay = strings.length >= 2 && strings.length === node.properties.length && strings.every((property) => displayLike(property.initializer.text));
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
      const value = property.initializer;
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) { if ((MODULE_DISPLAY_PROPS.has(name) || allDisplay) && displayLike(value.text) && isSentence(value.text)) into.add(value.text); continue; }
      if (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value) || ts.isAsExpression(value)) moduleLevelSentences(value, into, false);
    }
  }
}

/** The dotted keys and the English sentences one file references. */
export function referencesInFile(file, root = ROOT) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = new Set();
  const sentences = new Set();
  const isRoute = path.relative(root, file).startsWith(path.join("app", "api"));
  const visit = (node, fnName) => {
    if (ts.isFunctionDeclaration(node) && node.name) fnName = node.name.text;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (name === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
      if (name === "translate" && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) keys.add(node.arguments[1].text);
      if (SENTENCE_SINKS.has(name)) literals(node.arguments[SENTENCE_SINKS.get(name)], sentences);
      if (TUPLE_SINKS.has(name) && node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) literals(node.arguments[0].elements[0], sentences);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error" && node.arguments) {
      literals(node.arguments[0], sentences);
    } else if (isRoute && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "error") {
      literals(node.initializer, sentences);
    } else if (ts.isReturnStatement(node) && RETURNING_SINKS.has(fnName)) {
      literals(node.expression, sentences);
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "key" && ts.isStringLiteral(node.initializer) && /^[a-z]+\.[A-Za-z0-9]+$/.test(node.initializer.text)) {
      // { key: "reasons.nearby" } objects the interface translates later.
      keys.add(node.initializer.text);
    }
    ts.forEachChild(node, (child) => visit(child, fnName));
  };
  visit(sf, "");
  // Module-level constants reach the screen through tx(item.label); count their copy as referenced.
  const moduleCopy = new Set();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) if (declaration.initializer) moduleLevelSentences(declaration.initializer, moduleCopy, true);
  }
  return { keys, sentences, moduleCopy };
}

/** Sentences the database raises verbatim. A message with a % placeholder never matches. */
export function sqlSentences(root = ROOT) {
  const dir = path.join(root, "supabase", "migrations");
  const out = new Set();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    for (const match of sql.matchAll(/raise exception '((?:[^']|'')+)'/gi)) {
      const message = match[1].replaceAll("''", "'");
      if (!message.includes("%") && isSentence(message)) out.add(message);
    }
  }
  return out;
}

export function allReferences(root = ROOT) {
  const keys = new Set();
  const sentences = sqlSentences(root);
  const moduleCopy = new Set();
  for (const file of listSourceFiles(root)) {
    const found = referencesInFile(file, root);
    for (const key of found.keys) keys.add(key);
    for (const sentence of found.sentences) sentences.add(sentence);
    for (const sentence of found.moduleCopy) moduleCopy.add(sentence);
  }
  return { keys, sentences, moduleCopy };
}

export const placeholders = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort().join(" ");

/**
 * How the English table lines up with the source: sentences with no key,
 * keys nothing references (by key or by English text), and translations
 * whose placeholders differ from the English.
 */
export function checkMessages(messages, references) {
  const english = messages.en;
  const byText = new Map();
  for (const [key, value] of Object.entries(english)) if (!byText.has(value)) byText.set(value, key);
  const missing = [...references.sentences].filter((sentence) => !byText.has(sentence)).sort();
  const used = new Set(references.keys);
  for (const sentence of references.sentences) { const key = byText.get(sentence); if (key) used.add(key); }
  for (const sentence of references.moduleCopy ?? []) { const key = byText.get(sentence); if (key) used.add(key); }
  const stale = Object.keys(english).filter((key) => !used.has(key));
  const mismatched = [];
  for (const [locale, table] of Object.entries(messages)) {
    if (locale === "en") continue;
    for (const [key, value] of Object.entries(english)) {
      if (table[key] !== undefined && placeholders(table[key]) !== placeholders(value)) mismatched.push(`${locale}:${key}`);
    }
  }
  return { missing, stale, mismatched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const references = allReferences();
  console.log(`${references.keys.size} keys and ${references.sentences.size} English sentences referenced in source`);
  const { MESSAGES } = await import("./i18n-messages-loader.mjs");
  const { missing, stale, mismatched } = checkMessages(MESSAGES, references);
  console.log(`${Object.keys(MESSAGES.en).length} keys in the English table; ${missing.length} sentences without a key, ${stale.length} keys nothing references, ${mismatched.length} placeholder mismatches`);
  if (process.argv.includes("--verbose")) {
    for (const sentence of missing) console.log(`  missing: ${JSON.stringify(sentence)}`);
    for (const key of stale) console.log(`  stale: ${key}`);
    for (const entry of mismatched) console.log(`  placeholders: ${entry}`);
  }
}
