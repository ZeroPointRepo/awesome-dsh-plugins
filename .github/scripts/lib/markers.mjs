// Named marker scoping. One contract, one implementation.
//
// Every generator in this repository that reads or rewrites a region of README.md locates that
// region by a NAMED MARKER PAIR (`<!-- catalog:start -->` .. `<!-- catalog:end -->`), never by
// walking from one heading to the next.
//
// Why this file exists. The scripts here used to scope by heading range —
// `text.indexOf('## The catalog') .. text.indexOf('## Good to know')` — and two of them fell back
// to the WHOLE README when either heading moved. That combination is the auxiliary-section
// denominator-inflation bug: rename a heading and the catalog parser silently swallows the
// Featured entry, the Starter combos and every accordion below, so the count goes up, the badge
// goes up, and nothing anywhere reports a fault. A named marker cannot drift onto content it was
// not put around, and a missing one is a hard stop rather than a wider net.
//
// Rules, and they are the point of the module:
//   * A missing marker ABORTS. It never widens to the whole file and never returns empty. A
//     generator that cannot find its boundaries has no business guessing them.
//   * A DUPLICATED start marker aborts too. Two copies silently truncate the region at the second
//     one, which is the same class of failure wearing different clothes.
//   * `replaceRegion` preserves the indentation in front of the start marker onto the end marker,
//     so a block nested inside a list item does not creep left a little on every run.

const startTag = (name) => `<!-- ${name}:start -->`;
const endTag = (name) => `<!-- ${name}:end -->`;

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

/**
 * Locate a named region. Returns { inner, head, tail, from, to } where `inner` is the text
 * between the markers, `head` ends with the start marker and `tail` begins with the end marker.
 */
export function region(text, name, file = 'README.md') {
  const open = startTag(name);
  const close = endTag(name);
  const i = text.indexOf(open);
  if (i < 0) fail(`${file}: ${open} is missing. Refusing to guess the "${name}" boundaries.`);
  if (text.indexOf(open, i + open.length) >= 0) fail(`${file}: ${open} appears more than once. Refusing to guess which one bounds "${name}".`);
  const j = text.indexOf(close, i + open.length);
  if (j < 0) fail(`${file}: ${close} is missing after ${open}. Refusing to guess the "${name}" boundaries.`);
  return { inner: text.slice(i + open.length, j), head: text.slice(0, i + open.length), tail: text.slice(j), from: i + open.length, to: j };
}

/** The text between the markers. The common case. */
export const scope = (text, name, file = 'README.md') => region(text, name, file).inner;

/** Rewrite a named region with generated content. Returns the new document. */
export function replaceRegion(text, name, body, file = 'README.md') {
  const { head, tail } = region(text, name, file);
  const line = head.slice(head.lastIndexOf('\n') + 1);
  const indent = (line.match(/^[ \t]*/) || [''])[0];
  const indented = indent ? String(body).split('\n').map((l) => (l ? indent + l : l)).join('\n') : String(body);
  return `${head}\n${indented}\n${indent}${tail.slice(tail.indexOf(endTag(name)))}`;
}
