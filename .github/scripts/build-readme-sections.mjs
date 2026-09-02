#!/usr/bin/env node
// Regenerate every derived region of README.md from data already in the repo.
//
// All of it is numbers-and-names content, and the house rule is that prose is hand-written and
// numbers never are. So no region here is editable by hand: this script owns everything between
// its markers and rewrites it from the source of truth on every run. It is the ONLY writer of a
// number onto this page.
//
//   promise       - the headline count, from the entries between the catalog markers. It read 76
//                   against a real catalog of 81 for a week because it was hand-typed.
//   fullcatalog   - the pointer to CATALOG.md, carrying the RESOLVED count from plugins.json and
//                   saying "resolves" rather than "verified", which is a different tier.
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
import { scope, replaceRegion } from './lib/markers.mjs';

const file = process.argv[2] || 'README.md';
const LEDGER = '.github/data/first-seen.json';

const text = readFileSync(file, 'utf8');

// Same catalog scoping as verify-installs.mjs and refresh-stars.mjs, deliberately: three scripts,
// one contract, and since the marker migration one implementation of it. Anything outside the
// markers (Featured, Starter combos, the accordions) is not an entry.
const catalog = scope(text, 'catalog', file);

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

// --- the two verification tiers, and the counts that carry them ---------------------------------
// The page states BOTH numbers because they answer different questions and only one of them is a
// claim about function:
//   install-verified - the entries on this page, whose install command was re-run against the
//                      project's own source on the last pass.
//   resolved         - every plugin the generator could reach and index into CATALOG.md. Reaching
//                      a repository is not evidence that installing it works.
// Both come from files this repository generates. A missing or unparsable one aborts rather than
// printing a plausible number: a wrong count at the top of the page is worse than a failed run.
const readGenerated = (p, why) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${p}: ${e.message}. ${why}`);
    process.exit(2);
  }
};

const verifiedBadge = readGenerated('badges/verified.json', 'Refusing to state an install-verified count.');
const passRatio = /^(\d+)\/(\d+) passing$/.exec(String(verifiedBadge.message || ''));
if (!passRatio) {
  console.error(`badges/verified.json message "${verifiedBadge.message}" is not "N/M passing". Refusing to state an install-verified count.`);
  process.exit(2);
}
const installVerified = Number(passRatio[1]);

const feed = readGenerated('plugins.json', 'Refusing to state a resolved count.');
const resolved = Number(feed.count);
if (!Number.isInteger(resolved) || resolved < total) {
  console.error(`plugins.json count ${feed.count} is not a whole number at or above the ${total} entries on the page. Refusing to state a resolved count.`);
  process.exit(2);
}

const promise = `**${total} DeepSeek Harness (dsh) plugins, organized by what each one does for you.**`;
const fullCatalog = `- **Full catalog:** every DSH plugin this list resolves (${resolved}) in [CATALOG.md](CATALOG.md)`;

// The top-of-page badge is an endpoint file, so neither tier is ever typed into README.md.
const coverage = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${installVerified} install-verified / ${resolved} resolved`,
  color: '6799FE',
};
const coveragePath = 'badges/coverage.json';
const coverageBody = JSON.stringify(coverage, null, 2) + '\n';
let coverageChanged = false;
try {
  coverageChanged = readFileSync(coveragePath, 'utf8') !== coverageBody;
} catch {
  coverageChanged = true;
}
if (coverageChanged) writeFileSync(coveragePath, coverageBody);

// --- write -------------------------------------------------------------------------------------
let out = replaceRegion(text, 'dsh:panorama', panorama, file);
out = replaceRegion(out, 'dsh:recent', recent, file);
out = replaceRegion(out, 'promise', promise, file);
out = replaceRegion(out, 'fullcatalog', fullCatalog, file);

if (out === text && !coverageChanged) {
  console.log(`No change: ${total} entries across ${sections.length} sections, ${recentEntries.length} recently added, ${installVerified} install-verified / ${resolved} resolved.`);
  process.exit(0);
}
if (out !== text) writeFileSync(file, out);
console.log(
  `Rewrote panorama (${total} entries, ${sections.length} sections), recently-added ` +
    `(${recentEntries.length} since the ledger opened on ${opened}), the promise line and the full-catalog line in ${file}. ` +
    `Coverage: ${installVerified} install-verified / ${resolved} resolved.`
);
