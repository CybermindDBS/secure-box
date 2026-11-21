// Guards on the source itself: nothing in src/ may turn text into markup or code. React renders
// through DOM APIs, the page's Trusted Types policy only lets Secure Box's own scripts run as
// workers, and these checks keep it that way.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(m?js|jsx)$/.test(name) ? [path] : [];
  });
}

const SINKS = [
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
  [/\.(inner|outer)HTML\s*=/, 'innerHTML/outerHTML assignment'],
  [/insertAdjacentHTML/, 'insertAdjacentHTML'],
  [/document\.write\s*\(/, 'document.write'],
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function\s*\(/, 'new Function'],
  [/setTimeout\s*\(\s*['"`]/, 'setTimeout with a string'],
  [/createContextualFragment/, 'createContextualFragment'],
  [/srcdoc/, 'srcdoc'],
];

test('no HTML or code sinks anywhere in src/', () => {
  const found = [];
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8');
    for (const [pattern, name] of SINKS) if (pattern.test(text)) found.push(`${relative(root, file)}: ${name}`);
  }
  assert.deepEqual(found, []);
});

test('the page and firebase.json allow the same single Trusted Types policy', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const firebase = readFileSync(join(root, 'firebase.json'), 'utf8');
  assert.match(html, /trusted-types secure-box-scripts"/);
  assert.match(firebase, /trusted-types secure-box-scripts"/);
  const policies = sourceFiles(src).filter((file) => /createPolicy\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(policies.map((file) => relative(root, file).replaceAll('\\', '/')), ['src/core/trusted.js']);
});

test('styles are only ever linked, never injected', () => {
  const offenders = sourceFiles(src).filter((file) => /import\s+['"][^'"]+\.css['"]|createElement\(\s*['"]style['"]\s*\)/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
