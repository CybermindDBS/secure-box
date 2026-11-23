// Checks the production build before it's deployed: node scripts/check-build.mjs
// - dist/index.html carries the same Content-Security-Policy as firebase.json (minus the
//   directives a <meta> can't hold), and has no inline scripts, styles or style attributes;
// - every script and stylesheet it names exists, and is a file of the right kind;
// - the service worker and the classic scripts it imports are there, unhashed;
// - experiments (src/experiments.js) are left out of a production build, and are in an
//   experimental one (node scripts/check-build.mjs --experimental);
// - the privacy page is a plain page: no scripts, nothing inline, its own strict policy.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const problems = [];
const fail = (message) => problems.push(message);

if (!existsSync(join(dist, 'index.html'))) {
  console.error('No dist/index.html: run "npm run build" first.');
  process.exit(1);
}
const html = readFileSync(join(dist, 'index.html'), 'utf8');

// The policy in the page must match the one Firebase sends (frame-ancestors only works as a header).
const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
if (!meta) fail('index.html has no Content-Security-Policy <meta>.');
const firebase = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));
const pageHeaders = firebase.hosting.headers.find((rule) => rule.regex === '^/(index\\.html)?$')?.headers || [];
const header = pageHeaders.find((h) => h.key === 'Content-Security-Policy')?.value;
const directives = (policy) =>
  policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !d.startsWith('frame-ancestors'))
    .sort();
if (meta && header && JSON.stringify(directives(meta)) !== JSON.stringify(directives(header))) {
  fail(`The page's CSP and firebase.json's differ:\n  page:     ${directives(meta).join('; ')}\n  firebase: ${directives(header).join('; ')}`);
}
if (meta && !/script-src 'self'(;|$)/.test(meta)) fail("script-src must be exactly 'self'.");
if (meta && /unsafe-inline|unsafe-eval/.test(meta)) fail('The CSP must not allow unsafe-inline or unsafe-eval.');

// Nothing inline: every script has a src, there are no <style> elements or style attributes.
for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) if (!/\bsrc=/.test(tag)) fail(`Inline script: ${tag}`);
if (/<style\b/i.test(html)) fail('index.html has a <style> element.');
if (/\sstyle=/i.test(html)) fail('index.html has a style attribute.');
if (/\son[a-z]+=/i.test(html)) fail('index.html has an inline event handler.');

// Everything it loads is there.
const local = (url) => join(dist, url.replace(/^\.?\//, ''));
for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
  if (!existsSync(local(src))) fail(`Missing script: ${src}`);
  else if (!/\.m?js$/.test(src)) fail(`Script with an odd name: ${src}`);
}
for (const [, href] of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) {
  if (!existsSync(local(href))) fail(`Missing stylesheet: ${href}`);
}
for (const file of ['sw.js', 'manifest.webmanifest', 'assets/stream-core.js', 'assets/zip-core.js', 'assets/favicon.svg']) {
  if (!existsSync(join(dist, file))) fail(`Missing ${file}`);
}
const sw = existsSync(join(dist, 'sw.js')) ? readFileSync(join(dist, 'sw.js'), 'utf8') : '';
for (const [, list] of sw.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const [, path] of list.matchAll(/'([^']+)'/g)) if (!existsSync(join(dist, path))) fail(`sw.js imports a missing file: ${path}`);
}

// The privacy page: no scripts at all, nothing inline, and the policy firebase.json sends it.
const privacyFile = join(dist, 'privacy.html');
if (!existsSync(privacyFile)) fail('Missing privacy.html');
else {
  const page = readFileSync(privacyFile, 'utf8');
  if (/<script\b/i.test(page)) fail('privacy.html has a script: it must stay a plain page.');
  if (/<style\b/i.test(page) || /\sstyle=/i.test(page) || /\son[a-z]+=/i.test(page)) fail('privacy.html has an inline style or event handler.');
  for (const [, href] of page.matchAll(/(?:href|src)="(assets\/[^"]+)"/g)) if (!existsSync(join(dist, href))) fail(`privacy.html links a missing file: ${href}`);
  const rule = firebase.hosting.headers.find((r) => r.source === '/privacy.html');
  if (!rule?.headers.some((h) => h.key === 'Content-Security-Policy' && /default-src 'none'/.test(h.value) && !/script-src/.test(h.value))) fail('firebase.json must send privacy.html a policy that allows no scripts.');
}

// Experiments are named only in a build that has them (EXPERIMENTS in src/experiments.js): a
// production build must not, and the experimental one must, so this can't pass by accident.
const experimental = process.argv.includes('--experimental');
const scripts = readdirSync(join(dist, 'assets'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(join(dist, 'assets', name), 'utf8'))
  .join('\n');
const hasExperiments = /[`"']browser-vault[`"']/.test(scripts); // the minifier may quote it with backticks
if (!experimental && hasExperiments) fail('The browser vault experiment is in this production build. Build with "npm run build", not "--mode experimental".');
if (experimental && !hasExperiments) fail('The experimental build has no experiments in it.');

if (problems.length) {
  console.error(`Build check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Build check passed: same CSP as firebase.json, nothing inline, every file present, ${experimental ? 'experiments on (experimental build)' : 'no experiments'}.`);
