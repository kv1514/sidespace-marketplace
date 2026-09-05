#!/usr/bin/env node
/**
 * Every English string the interface can show, read from the source.
 *
 * A key is the first argument of t() or msg(), of setToast() and the state
 * setters that render what they are given, of new Error() (its message ends
 * up in a toast), of the onboarding and listing validators, and the `error`
 * a route hands back to the browser. Sentences the database raises are keys
 * too, because they reach members through the same toasts. Conditionals and
 * `||` fallbacks are followed, so `setToast(ok ? "A" : "B")` yields both.
 *
 * Run it to see what each dictionary is missing or no longer needs:
 *
 *   node scripts/i18n-keys.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SOURCE_DIRS = ["app", "components", "lib"];
const LOCALES = ["es", "zh", "ko", "vi"];

/** Functions whose argument at the given index is shown to a member. */
const SINKS = new Map([
  ["t", 0], ["msg", 0], ["setToast", 0], ["confirm", 0], ["alert", 0], ["prompt", 0],
  ["need", 1], ["invalid", 1],
  ["setOnboardingError", 0], ["setCampaignFeedback", 0], ["setListingFeedback", 0],
  ["setCropError", 0], ["setDeleteAccountError", 0], ["setLocationError", 0],
]);
/** Functions whose argument is a [message, field] tuple. */
const TUPLE_SINKS = new Set(["reportMissing"]);
/** Brand and product names never translate; a symbol or an abbreviation is not a sentence. */
const SKIP = new Set(["SideSpace", "Stripe", "Instagram", "TikTok", "YouTube", "Google", "Supabase", "Vercel", "Slack"]);

const isSentence = (text) => /[A-Za-z]/.test(text) && text.trim().length > 1 && !(text.length <= 3 && !/[a-z]/.test(text)) && !SKIP.has(text);

export function listSourceFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
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
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { if (isSentence(node.text)) into.add(node.text); }
}

export function keysInFile(file, root = ROOT) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = new Set();
  const isRoute = path.relative(root, file).startsWith(path.join("app", "api"));
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (SINKS.has(name)) literals(node.arguments[SINKS.get(name)], keys);
      if (TUPLE_SINKS.has(name) && node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) literals(node.arguments[0].elements[0], keys);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error" && node.arguments) {
      literals(node.arguments[0], keys);
    } else if (isRoute && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "error") {
      literals(node.initializer, keys);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/** Sentences the database raises verbatim. A message with a % placeholder never matches a key. */
export function sqlKeys(root = ROOT) {
  const dir = path.join(root, "supabase", "migrations");
  const keys = new Set();
  if (!fs.existsSync(dir)) return keys;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    for (const match of sql.matchAll(/raise exception '((?:[^']|'')+)'/gi)) {
      const message = match[1].replaceAll("''", "'");
      if (!message.includes("%") && isSentence(message)) keys.add(message);
    }
  }
  return keys;
}

export function allKeys(root = ROOT) {
  const keys = new Set(sqlKeys(root));
  for (const file of listSourceFiles(root)) for (const key of keysInFile(file, root)) keys.add(key);
  return keys;
}

export const placeholders = (text) => (text.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort().join(" ");

export function checkDictionary(dictionary, keys) {
  const missing = [...keys].filter((key) => !dictionary[key]);
  const stale = Object.keys(dictionary).filter((key) => !keys.has(key));
  const mismatched = [...keys].filter((key) => dictionary[key] && placeholders(dictionary[key]) !== placeholders(key));
  return { missing, stale, mismatched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = allKeys();
  console.log(`${keys.size} keys in source`);
  for (const locale of LOCALES) {
    const file = path.join(ROOT, "lib", "i18n", "dictionaries", `${locale}.json`);
    const dictionary = JSON.parse(fs.readFileSync(file, "utf8"));
    const { missing, stale, mismatched } = checkDictionary(dictionary, keys);
    console.log(`${locale}: ${Object.keys(dictionary).length} entries, ${missing.length} missing, ${stale.length} stale, ${mismatched.length} placeholder mismatches`);
    if (process.argv.includes("--verbose")) {
      for (const key of missing) console.log(`  missing: ${JSON.stringify(key)}`);
      for (const key of stale) console.log(`  stale: ${JSON.stringify(key)}`);
      for (const key of mismatched) console.log(`  placeholders: ${JSON.stringify(key)} -> ${JSON.stringify(dictionary[key])}`);
    }
  }
  if (process.argv.includes("--json")) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "i18n", "dictionaries", "es.json"), "utf8"));
    console.log(JSON.stringify([...keys].filter((key) => !dictionary[key]).sort(), null, 2));
  }
}
