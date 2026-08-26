#!/usr/bin/env node
// Regenerate the two derived regions of README.md from data already in the repo.
//
// Both are numbers-and-names content, and the house rule is that prose is hand-written and
// numbers never are. So neither region is editable by hand: this script owns everything between
// its markers and rewrites it from the source of truth on every run.
//
//   dsh:panorama  - the shape of the catalog: every section and how many entries sit in it.
//                   Derived from README.md's own catalog, so the map cannot disagree with the
//                   page it is drawn on. Add an entry and the map moves in the same run that
//                   refreshes the badge.
//   dsh:recent    - entries whose first-seen date is later than the day the ledger opened.
//                   The ledger's own note says the opening-day rows are "the first date we
//                   actually recorded, not the date we listed it", so treating them as new
//                   would be back-dating by another name. They are excluded, which is why this
//                   region can legitimately be empty and prints an honest empty state instead
//                   of filler.
//
// Scoped to entries that are ON THIS PAGE. The full catalog is larger, but a row that never
// carried a verified install command here has no business appearing in a section a reader will
// read as "newly listed".
//
// Offline and deterministic: no network, no clock. Idempotent, so it does not manufacture
// commits on a week where nothing moved.
//
// Usage: node .github/scripts/build-readme-sections.mjs [README.md]

import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] || 'README.md';
const LEDGER = '.github/data/first-seen.json';

const text = readFileSync(file, 'utf8');

// Same catalog scoping as verify-installs.mjs and refresh-stars.mjs, deliberately: three scripts,
// one contract. Anything outside it (Featured, Starter combos, the accordions) is not an entry.
const start = text.indexOf('## The catalog');
const end = text.indexOf('## Good to know');
if (start < 0 || end <= start) {
  console.error('Could not locate the catalog section; refusing to rewrite blindly.');
  process.exit(2);
}
const catalog = text.slice(start, end);

// Section -> entries, in page order. An entry is a bold action line carrying a GitHub repo link.
const sections = [];
let current = null;
for (const line of catalog.split('\n')) {
  const heading = line.match(/^### (.+?)\s*$/);
  if (heading) {
    current = { name: heading[1], slugs: [] };
    sections.push(current);
    continue;
  }
  if (!current || !/^- \*\*/.test(line)) continue;
  const m = line.match(/\[([^\]]+)\]\(https:\/\/github\.com\/([^/)]+)\/([^/)#]+)\)/);
  if (m) current.slugs.push({ name: m[1], slug: `${m[2]}/${m[3].replace(/\.git$/i, '')}` });
}

const total = sections.reduce((n, s) => n + s.slugs.length, 0);
if (!sections.length || !total) {
  console.error('Parsed no catalog entries; refusing to write an empty panorama.');
  process.exit(2);
}

// --- panorama ----------------------------------------------------------------------------------
// Deepest job first, then alphabetically, so the map answers "where is this list actually strong?"
// rather than repeating the page's own order.
const ranked = [...sections].sort((a, b) => b.slugs.length - a.slugs.length || a.name.localeCompare(b.name));
const panorama = [
  '```mermaid',
  'mindmap',
  `  root((Awesome DSH Plugins · ${total}))`,
  ...ranked.map((s) => `    ${s.name} · ${s.slugs.length}`),
  '```',
].join('\n');

// --- recently added ------------------------------------------------------------------------------
// A failed or missing read must not print as "nothing new". Absence of evidence is not evidence of
// absence, so an unreadable ledger aborts the run instead of quietly emptying the section.
let ledger;
try {
  ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
} catch (e) {
  console.error(`Could not read ${LEDGER}: ${e.message}. Refusing to write an empty "recently added".`);
  process.exit(2);
}
const seen = ledger.seen || {};
const dates = Object.values(seen).filter((d) => typeof d === 'string');
if (!dates.length) {
  console.error(`${LEDGER} holds no dates; refusing to write an empty "recently added".`);
  process.exit(2);
}
const opened = dates.reduce((a, b) => (a < b ? a : b));

const anchor = (name) =>
  '#' + name.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

const recentEntries = [];
for (const section of sections) {
  for (const entry of section.slugs) {
    const date = seen[entry.slug];
    if (date && date > opened) recentEntries.push({ ...entry, date, section: section.name });
  }
}
recentEntries.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));

const recent = recentEntries.length
  ? recentEntries
      .slice(0, 10)
      .map(
        (e) =>
          `- **[${e.name}](https://github.com/${e.slug})** in [${e.section}](${anchor(e.section)}), added ${e.date}`
      )
      .join('\n')
  : 'No new entries this week. [Add one](CONTRIBUTING.md).';

// --- write -------------------------------------------------------------------------------------
function replaceRegion(md, key, body) {
  const open = `<!-- dsh:${key}:start -->`;
  const close = `<!-- dsh:${key}:end -->`;
  const i = md.indexOf(open);
  const j = md.indexOf(close);
  if (i < 0 || j <= i) {
    console.error(`Missing ${open} / ${close} markers in ${file}.`);
    process.exit(2);
  }
  return md.slice(0, i + open.length) + '\n' + body + '\n' + md.slice(j);
}

let out = replaceRegion(text, 'panorama', panorama);
out = replaceRegion(out, 'recent', recent);

if (out === text) {
  console.log(`No change: ${total} entries across ${sections.length} sections, ${recentEntries.length} recently added.`);
  process.exit(0);
}
writeFileSync(file, out);
console.log(
  `Rewrote panorama (${total} entries, ${sections.length} sections) and recently-added ` +
    `(${recentEntries.length} since the ledger opened on ${opened}) in ${file}.`
);
