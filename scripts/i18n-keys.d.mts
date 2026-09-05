export function listSourceFiles(root?: string): string[];
export function keysInFile(file: string, root?: string): Set<string>;
export function sqlKeys(root?: string): Set<string>;
export function allKeys(root?: string): Set<string>;
export function placeholders(text: string): string;
export function checkDictionary(
  dictionary: Record<string, string>,
  keys: Set<string>,
): { missing: string[]; stale: string[]; mismatched: string[] };
