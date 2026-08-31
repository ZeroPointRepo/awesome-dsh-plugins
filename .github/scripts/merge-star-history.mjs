#!/usr/bin/env node
// Merge two star-history.json ledgers. Used by the generator workflow's push-replay loop when
// a second run landed on main first.
//
// Every field here has a KNOWN ERROR DIRECTION, which is the only reason this file may merge at
// all (catalog crew ruling, 2026-08-24). Counts, descriptions and verified flags have no such
// direction and are replayed wholesale instead of merged — never add one of those to this file.
//
//   stars[date]  append-only. Whatever landed on main first stays. Two runs on the same date
//                are two readings of the same day; neither is more truthful, so the tie is
//                broken deterministically in favour of the record that already exists rather
//                than by overwriting history.
//   first_seen   earliest wins. A first-seen date can only ever be recorded too late.
//   slugs        union, order-preserving. A rename trail only ever grows.
//   slug         the label from whichever ledger has the most recent snapshot date.
//
// Usage: node .github/scripts/merge-star-history.mjs <mine.json> <theirs.json> -> writes theirs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [mineP, theirsP] = process.argv.slice(2);
const read = (p) => {
  if (!p || !existsSync(p)) return { repos: {} };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j.repos === 'object' && j.repos ? j : { repos: {} };
  } catch {
    return { repos: {} };
  }
};

const mine = read(mineP);
const theirs = read(theirsP);
const out = { ...theirs, ...mine, repos: {} };
const latest = (r) => Object.keys(r.stars || {}).sort().pop() || '';

for (const id of new Set([...Object.keys(theirs.repos), ...Object.keys(mine.repos)])) {
  const a = mine.repos[id];
  const b = theirs.repos[id];
  if (!a || !b) { out.repos[id] = a || b; continue; }
  // theirs first, so an existing dated reading is never displaced by ours
  const stars = { ...a.stars, ...b.stars };
  const slugs = [...(b.slugs || [])];
  for (const s of a.slugs || []) if (!slugs.includes(s)) slugs.push(s);
  const fs = [a.first_seen, b.first_seen].filter(Boolean).sort()[0];
  out.repos[id] = {
    slug: latest(a) >= latest(b) ? a.slug : b.slug,
    slugs,
    first_seen: fs,
    stars: Object.fromEntries(Object.entries(stars).sort(([x], [y]) => x.localeCompare(y))),
  };
}

out.repos = Object.fromEntries(Object.entries(out.repos).sort(([a], [b]) => Number(a) - Number(b)));
writeFileSync(theirsP, JSON.stringify(out, null, 2) + '\n');
console.log(`merged star-history: ${Object.keys(out.repos).length} repos tracked`);
