#!/usr/bin/env node
// Rewrite the star figure on every catalog entry from the live GitHub API.
//
// WHY THIS EXISTS. The README's "N★, LICENSE." figures are hand-written, and in this
// ecosystem they rot within days: on 2026-08-24 a sweep found 54 of 75 more than 5% off,
// several by half (dsh-context 647 -> 979, dsh-synapse 128 -> 194, univer-office 60 -> 101).
// A stale number is not a cosmetic problem on a list whose whole pitch is that its entries
// are checked.
//
// The irritating part is that nothing here was missing: verify-installs.mjs already resolves
// every one of these repos through the API every Monday, and build-catalog.mjs already sorts
// CATALOG.md by live star count. The number was fetched weekly and thrown away for the one
// file a human actually reads. This closes that loop.
//
// Entry shape (same parser contract as verify-installs.mjs, deliberately):
//   - **What it does** with [name](https://github.com/owner/repo) by [author](url). Desc. 1,234★, MIT.
//
// Only the digits before ★ are touched. Never the description, never the command, never a
// figure on a line with no GitHub link. Idempotent: re-running with no upstream movement is a
// no-op, so it will not produce empty weekly commits.
//
// Usage: GH_TOKEN=... node .github/scripts/refresh-stars.mjs README.md

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const file = process.argv[2] || 'README.md';
const H = {
  'User-Agent': 'awesome-dsh-plugins-stars',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const text = readFileSync(file, 'utf8');
// Same catalog scoping as verify-installs.mjs: the Featured plugin entry and anything inside
// the collapsed "Good to know" accordions are out of scope on purpose.
const start = text.indexOf('## The catalog');
const end = text.indexOf('## Good to know');
if (start < 0 || end <= start) {
  console.error('Could not locate the catalog section; refusing to rewrite blindly.');
  process.exit(1);
}

const head = text.slice(0, start);
const tail = text.slice(end);
const lines = text.slice(start, end).split('\n');

// Match the house style exactly: plain integer, comma-grouped above 999 (1,570★ — not 1.6k★).
// This file has never used k-suffixes and the refresher must not quietly introduce them; a
// formatting drift across 66 lines is a worse diff than the stale numbers it was fixing.
const fmt = (n) => n.toLocaleString('en-US');
const parse = (t) => {
  const s = t.trim().toLowerCase();
  return s.endsWith('k') ? Math.round(parseFloat(s) * 1000) : parseInt(s.replace(/,/g, ''), 10);
};

const targets = [];
for (let i = 0; i < lines.length; i++) {
  if (!/^- \*\*/.test(lines[i])) continue;
  const m = lines[i].match(/\[([^\]]+)\]\(https:\/\/github\.com\/([^/)]+)\/([^/)#]+)\)/);
  const star = lines[i].match(/([\d][\d,.]*k?)★/i);
  if (!m || !star) continue;
  targets.push({ i, slug: `${m[2]}/${m[3].replace(/\.git$/i, '')}`, was: star[1], name: m[1] });
}

console.log(`Refreshing ${targets.length} star figures in ${file}\n`);

let changed = 0, failed = 0;
let q = 0;
async function worker() {
  while (q < targets.length) {
    const t = targets[q++];
    let j;
    try {
      const r = await fetch(`https://api.github.com/repos/${t.slug}`, { headers: H });
      if (!r.ok) {
        // Never guess. A rate-limited or 404 run leaves the existing figure alone and says so.
        failed++;
        console.log(`  SKIP  ${t.slug} (HTTP ${r.status}) — figure left at ${t.was}★`);
        continue;
      }
      j = await r.json();
    } catch (e) {
      failed++;
      console.log(`  SKIP  ${t.slug} (network) — figure left at ${t.was}★`);
      continue;
    }
    const now = fmt(j.stargazers_count);
    if (now === t.was) continue;
    const before = parse(t.was);
    const drift = before ? Math.round(((j.stargazers_count - before) / before) * 100) : 0;
    lines[t.i] = lines[t.i].replace(`${t.was}★`, `${now}★`);
    changed++;
    console.log(`  ${t.name}: ${t.was}★ -> ${now}★  (${drift > 0 ? '+' : ''}${drift}%)`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

if (changed) writeFileSync(file, head + lines.join('\n') + tail);
console.log(`\nchanged=${changed} unchecked=${failed} total=${targets.length}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nunchecked=${failed}\n`);
}
process.exit(0);
