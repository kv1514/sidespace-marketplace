export function listSourceFiles(root?: string): string[];
export function referencesInFile(file: string, root?: string): { keys: Set<string>; sentences: Set<string>; moduleCopy: Set<string> };
export function sqlSentences(root?: string): Set<string>;
export function allReferences(root?: string): { keys: Set<string>; sentences: Set<string>; moduleCopy: Set<string> };
export function placeholders(text: string): string;
export function checkMessages(
  messages: Record<string, Record<string, string>>,
  references: { keys: Set<string>; sentences: Set<string>; moduleCopy: Set<string> },
): { missing: string[]; stale: string[]; mismatched: string[] };
