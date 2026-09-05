// Loads the TypeScript message tables for the CLI, which runs without a bundler.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "lib", "i18n-messages");
const load = (name) => {
  const source = fs.readFileSync(path.join(dir, `${name}.ts`), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", "require", js)(mod, mod.exports, () => ({}));
  return Object.values(mod.exports)[0];
};
export const MESSAGES = { en: load("en"), es: load("es"), fr: load("fr"), zh: load("zh"), ko: load("ko"), vi: load("vi") };
