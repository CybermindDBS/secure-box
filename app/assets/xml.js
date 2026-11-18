/**
 * Tiny, forgiving XML parser for the well-formed XML inside Office/OpenDocument files.
 * Builds plain objects (never DOM), so nothing in a document can ever run as code.
 */
const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    if (e[0] !== '#') return ENTITY[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[2]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[2]) {
          stack.length = i;
          break;
        }
      }
    } else if (m[3]) {
      const attrs = {};
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(m[4] || ''))) attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
      const el = { name: m[3], attrs, children: [] };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.children.push(decodeEntities(m[6]));
  }
  return root;
}

export const kids = (el, name) => (el?.children || []).filter((c) => typeof c !== 'string' && (!name || c.name === name));

export function findAll(el, name, out = []) {
  for (const child of el?.children || []) {
    if (typeof child === 'string') continue;
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

export function find(el, name) {
  for (const child of el?.children || []) {
    if (typeof child === 'string') continue;
    if (child.name === name) return child;
    const hit = find(child, name);
    if (hit) return hit;
  }
  return null;
}

export function textOf(el) {
  if (!el) return '';
  if (typeof el === 'string') return el;
  return el.children.map(textOf).join('');
}
