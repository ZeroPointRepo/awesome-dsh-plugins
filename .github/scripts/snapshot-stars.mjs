#!/usr/bin/env node
// Append a dated star snapshot for every catalog entry to .github/data/star-history.json.
//
// WHY THIS EXISTS. You cannot backdate a time series. An anomaly detector that spots a
// manufactured star run (the bruc3van pattern: a repo that gains 2,000 stars in 48h from
// same-day accounts) is worthless if nobody recorded what the stars were last week. That
// detector is not built yet and is deliberately not being built here — this is the data
// capture that has to happen FIRST, for the same reason first-seen.json had to exist before
// anything could use it. Same lesson, same shape.
//
// KEYED BY IMMUTABLE REPO ID, NEVER BY owner/name.
// bruc3van shipped a name-keyed blacklist and a single rename walked straight through it two
// days later. GitHub's numeric repo id survives renames, owner transfers and re-casing; the
// slug survives none of them. Every record here hangs off `databaseId`. The slug is carried
// alongside as a *label* and its history is kept, because "this id has answered to three
// different names" is itself the evidence a rename-based evasion leaves behind.
//
// APPEND-ONLY. A date already present is never rewritten, on any code path. History is a
// record of what we observed, not a cache of what is currently true — if a past reading was
// wrong, the honest fix is a new dated reading, not a quiet edit of the old one.
//
// COSTS ~1 API CALL PER 100 ENTRIES. It reads the freshly generated CATALOG.md rather than
// re-walking the README, and resolves in GraphQL batches. It is a step inside the existing
// weekly generator job, never a second cron: the real ceiling in this portfolio is one catalog
// walk at a time, so a snapshot that needed a walk of its own would not be worth having.
//
// Usage: GH_TOKEN=... node .github/scripts/snapshot-stars.mjs [CATALOG.md] [.github/data/star-history.json]

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CATALOG = process.argv[2] || 'CATALOG.md';
const LEDGER = process.argv[3] || '.github/data/star-history.json';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
// Overridable so a replay or a backfill can state its own date; never invented per-batch.
const DATE = process.env.SNAPSHOT_DATE || new Date().toISOString().slice(0, 10);
// Above this share of unresolved entries the run refuses to write. A rate-limited run that
// wrote anyway would leave a thin week in the series that reads, later, exactly like a week in
// which half the catalog lost its stars. Same third-state doctrine as the cursor build.
const MAX_UNRESOLVED = 0.05;

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`Refusing to write: SNAPSHOT_DATE=${DATE} is not YYYY-MM-DD.`);
  process.exit(1);
}

// ---------------------------------------------------------------- the catalog membership
// CATALOG.md is generated immediately before this step, so it is exactly the set of entries
// that is about to be published — not the set the README happened to contain when the job
// started. Rows are `| [name](https://github.com/owner/repo) | ... |`.
const md = readFileSync(CATALOG, 'utf8');
const slugs = new Map(); // lowercased slug -> as-written slug
for (const line of md.split('\n')) {
  if (!line.startsWith('| [')) continue;
  const m = line.match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!m) continue;
  const slug = `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
  if (!slugs.has(slug.toLowerCase())) slugs.set(slug.toLowerCase(), slug);
}
const list = [...slugs.values()];
console.log(`${CATALOG}: ${list.length} distinct repos to snapshot for ${DATE}`);
if (!list.length) {
  // An empty catalog is a generator failure upstream, not an empty week. Never write it.
  console.error('Catalog produced no GitHub repos — refusing to write an empty snapshot.');
  process.exit(1);
}

// ---------------------------------------------------------------- resolve, in batches of 100
async function graphql(query) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'User-Agent': 'awesome-star-snapshot',
          'Content-Type': 'application/json',
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: JSON.stringify({ query }),
      });
      if (r.status === 502 || r.status === 503 || r.status === 429) {
        await new Promise((s) => setTimeout(s, 2000 * attempt));
        continue;
      }
      if (!r.ok) return { data: null, http: r.status };
      return await r.json();
    } catch {
      await new Promise((s) => setTimeout(s, 2000 * attempt));
    }
  }
  return { data: null, http: 0 };
}

const resolved = []; // { id, slug, stars }
const unresolved = []; // slugs we could not read — recorded as nothing, never as zero
for (let i = 0; i < list.length; i += 100) {
  const batch = list.slice(i, i + 100);
  const q = `query {\n${batch
    .map((s, n) => {
      const [o, r] = s.split('/');
      return `  r${n}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(r)}) { databaseId nameWithOwner stargazerCount }`;
    })
    .join('\n')}\n}`;
  const res = await graphql(q);
  if (!res.data) {
    unresolved.push(...batch);
    console.log(`  batch ${i / 100 + 1}: unreadable (HTTP ${res.http ?? '?'}) — ${batch.length} entries left unrecorded`);
    continue;
  }
  batch.forEach((s, n) => {
    const node = res.data[`r${n}`];
    if (!node || typeof node.databaseId !== 'number' || typeof node.stargazerCount !== 'number') {
      unresolved.push(s);
      return;
    }
    resolved.push({ id: String(node.databaseId), slug: node.nameWithOwner, stars: node.stargazerCount });
  });
}

const rate = unresolved.length / list.length;
console.log(`resolved=${resolved.length} unresolved=${unresolved.length} (${(rate * 100).toFixed(1)}%)`);
for (const s of unresolved.slice(0, 20)) console.log(`  UNRESOLVED ${s} — no snapshot written for it this run`);
if (unresolved.length > 20) console.log(`  ... and ${unresolved.length - 20} more`);
if (rate > MAX_UNRESOLVED) {
  console.error(
    `\nRefusing to write: ${(rate * 100).toFixed(1)}% of the catalog was unreadable (ceiling ${MAX_UNRESOLVED * 100}%).\n` +
      'A partial snapshot is indistinguishable, a month from now, from a week the entries really vanished.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------- append
const empty = {
  _comment:
    'Append-only dated star ledger. Keyed by GitHub\'s IMMUTABLE numeric repo id (databaseId), never by owner/name: a rename defeats a name-keyed record and renames are exactly what evasion looks like. A date, once written, is never rewritten. `slugs` is the rename trail for that id, oldest first. Generated by .github/scripts/snapshot-stars.mjs; do not hand-edit.',
  schema: 1,
  repos: {},
};
let led = empty;
if (existsSync(LEDGER)) {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER, 'utf8'));
    if (parsed && typeof parsed.repos === 'object' && parsed.repos) led = { ...empty, ...parsed };
  } catch (e) {
    // A corrupt ledger must stop the run. Silently starting a fresh one would delete the whole
    // series, and the series is the entire point of the file.
    console.error(`Refusing to write: ${LEDGER} exists but does not parse (${e.message}).`);
    process.exit(1);
  }
}

let added = 0, held = 0, renamed = 0, fresh = 0;
for (const { id, slug, stars } of resolved) {
  const rec = (led.repos[id] ||= { slug, slugs: [slug], first_seen: DATE, stars: {} });
  rec.stars ||= {};
  rec.slugs ||= [rec.slug].filter(Boolean);
  if (rec.first_seen === DATE && Object.keys(rec.stars).length === 0) fresh++;
  // first_seen can only ever be recorded TOO LATE, so the earlier reading is always the
  // truthful one. Identical rule to first-seen.json, and the reason both merge for free.
  if (!rec.first_seen || DATE < rec.first_seen) rec.first_seen = DATE;
  if (rec.slug !== slug) {
    console.log(`  RENAME id=${id}: ${rec.slug} -> ${slug}`);
    renamed++;
  }
  rec.slug = slug;
  if (!rec.slugs.includes(slug)) rec.slugs.push(slug);
  // Append-only: a date already on record is evidence, not a cache entry.
  if (Object.prototype.hasOwnProperty.call(rec.stars, DATE)) held++;
  else { rec.stars[DATE] = stars; added++; }
}

// Stable key order so a diff shows only the rows that actually moved.
led.repos = Object.fromEntries(
  Object.entries(led.repos)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, v]) => [k, { ...v, stars: Object.fromEntries(Object.entries(v.stars).sort(([a], [b]) => a.localeCompare(b))) }])
);

mkdirSync(dirname(LEDGER), { recursive: true });
writeFileSync(LEDGER, JSON.stringify(led, null, 2) + '\n');

const tracked = Object.keys(led.repos).length;
console.log(
  `\n${LEDGER}: ${tracked} repos tracked · +${added} snapshots for ${DATE}` +
    ` · ${fresh} newly tracked · ${held} already on record (left alone) · ${renamed} rename(s) recorded`
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `snapshots=${added}\ntracked=${tracked}\nunresolved=${unresolved.length}\n`);
}
