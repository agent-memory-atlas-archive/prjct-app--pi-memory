import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// The previous gate was `grep -rn '\blet\b' src/`, which matches the English
// word "let" in a comment or a string as readily as a binding. Tokenizing with
// the TypeScript scanner checks the rule that was actually intended.
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return walk(path);
  return entry.isFile() && path.endsWith('.ts') ? [path] : [];
});

const offences = walk('src').flatMap(path => {
  const text = readFileSync(path, 'utf8');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.Standard, text);
  const found: string[] = [];
  const next = (): ts.SyntaxKind => scanner.scan();
  for (const kind of (function* tokens(): Generator<ts.SyntaxKind> {
    for (;;) {
      const kind = next();
      if (kind === ts.SyntaxKind.EndOfFileToken) return;
      yield kind;
    }
  })()) {
    if (kind !== ts.SyntaxKind.LetKeyword) continue;
    const { line, character } = ts.getLineAndCharacterOfPosition(
      ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false), scanner.getTokenStart());
    found.push(`${path}:${line + 1}:${character + 1}`);
  }
  return found;
});

if (offences.length) {
  console.error(`Use immutable values: no let bindings in src/\n${offences.map(place => `  ${place}`).join('\n')}`);
  process.exit(1);
}
if (statSync('src').isDirectory()) console.log('check:immutable ok — no let bindings in src/');
