#!/usr/bin/env node
// Build CATALOG.md: the full machine-built index of DSH plugins.
//
// README.md is the curated, organized page and is written by hand. CATALOG.md is not: it is
// rebuilt from scratch on every run of the weekly verify-installs workflow, from two sources that
// are both authoritative rather than remembered:
//
//   1. README.md's own catalog section - the curated entries, parsed out of the page itself so the
//      two files can never drift apart.
//   2. The GitHub repository-search API - every repo carrying the dsh plugin topics or a dsh
//      install command in its README, top-of-search by stars, capped at MAX_CANDIDATES.
//
// Every candidate then has to earn its row the same way a README entry does: the repo has to
// resolve through the API, not be archived or a fork, and its OWN README has to contain a real
// `dsh plugin ... add <spec>` line that names the repo itself. Anything that fails is dropped, and
// the drop counts are printed so a shrinking catalog is visible rather than silent.
//
// Usage: GH_TOKEN=... node .github/scripts/build-catalog.mjs
// Writes CATALOG.md and refreshes the entry count in README.md's "Full catalog" line.

import { readFileSync, writeFileSync } from 'node:fs';
import { scope } from './lib/markers.mjs';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 400);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

const H = {
  'User-Agent': 'awesome-dsh-plugins-catalog',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, tries = 5) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await fetch(url, { headers: H });
    if (r.ok) return r;
    // Secondary rate limiting is the normal failure here, and it is temporary. Waiting it out is
    // the difference between a verified row and a row that silently reads as unverified.
    if (r.status === 403 || r.status === 429) {
      const retryAfter = Number(r.headers.get('retry-after')) || 0;
      await sleep(Math.max(retryAfter * 1000, 4000 * 2 ** i));
      continue;
    }
    return r;
  }
  return r;
}

// ---------------------------------------------------------------- README (curated entries)

const readme = readFileSync('README.md', 'utf8');
// Marker-scoped, not heading-scoped. This used to window from "## The catalog" to "## Good to
// know" and fall back to the WHOLE README when either heading moved, which silently pulled the
// Featured entry, the Starter combos and every accordion into the entry count. `scope` aborts
// instead. See .github/scripts/lib/markers.mjs.
const catalogText = scope(readme, 'catalog');
const rLines = catalogText.split('\n');

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const curated = [];
let section = null;
for (let i = 0; i < rLines.length; i++) {
  const h = rLines[i].match(/^### (.+?)\s*$/);
  if (h) section = h[1];
  if (!/^- \*\*/.test(rLines[i])) continue;
  const headline = (rLines[i].match(/^- \*\*(.+?)\*\*/) || [])[1] || null;
  let slug = null;
  let name = null;
  let cmd = null;
  for (let j = i; j < Math.min(i + 12, rLines.length); j++) {
    if (j > i && /^- \*\*/.test(rLines[j])) break;
    if (!slug) {
      const m = rLines[j].match(/\[([^\]]+)\]\(https:\/\/github\.com\/([^/)]+)\/([^/)#]+)\)/);
      if (m) {
        name = m[1];
        slug = `${m[2]}/${m[3].replace(/\.git$/i, '')}`;
      }
    }
    if (/^\s*```/.test(rLines[j])) {
      cmd = (rLines[j + 1] || '').trim();
      break;
    }
  }
  if (!slug) continue;
  curated.push({ slug, name, cmd, headline, section, curated: true });
}
console.log(`Curated entries parsed from README.md: ${curated.length}`);

// ---------------------------------------------------------------- discovery (repo search)

const QUERIES = [
  'topic:dsh-plugin',
  'topic:deepseek-harness',
  '"dsh plugin --profile" in:readme',
  '"dsh plugin add" in:readme',
];

// The harness itself, list repos, and our own repo are not plugins.
const DENY_OWNERS = new Set(['deepseek-ai']);
const isList = (fullName) => /(^|\/)(awesome[-_]|dsh[-_]?plugins?[-_]list)/i.test(fullName.split('/')[1] || '');

const found = new Map(); // full_name -> search hit
let searchPages = 0;
for (const q of QUERIES) {
  for (let page = 1; page <= 3; page++) {
    const r = await api(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`
    );
    searchPages++;
    if (!r.ok) {
      console.log(`  search "${q}" page ${page}: HTTP ${r.status}, skipping rest of this query`);
      break;
    }
    const j = await r.json();
    const items = j.items || [];
    for (const it of items) {
      if (it.archived || it.fork) continue;
      if (DENY_OWNERS.has(it.full_name.split('/')[0])) continue;
      if (isList(it.full_name)) continue;
      if (!found.has(it.full_name)) found.set(it.full_name, it);
    }
    if (items.length < 100) break;
    await sleep(2500); // search API is 30 req/min
  }
  await sleep(2500);
}
console.log(`Discovery: ${found.size} unique candidate repos from ${searchPages} search requests`);
if (found.size === 0) {
  // Search failed rather than the ecosystem vanishing. Leave the last good catalog in place.
  console.error('Search returned nothing. Keeping the existing CATALOG.md instead of shrinking it.');
  process.exit(1);
}


// ─── WHAT A STAR COUNT IS ALLOWED TO DECIDE IN THIS FILE ─────────────────────────────────────
// A star count is a purchasable number. This catalog's standing rule is "we catalog code, not
// stars": an entry earns its place by having an install command that actually resolves, which is
// what verify-installs.mjs measures and what the ✅ column reports. Nothing below removes an
// entry over its star count, and nothing should.
//
// But stars are read in three different places here, and they are NOT the same kind of use.
// The test is PRIVILEGE, NOT PRESENCE — what does the number get to DECIDE?
//   1. SHORTLIST  (`ranked.slice(0, MAX_CANDIDATES)`, just below) — stars decide WHO GETS CHECKED
//      AT ALL. A high count pushes a lower-starred plugin off the end of the run entirely. This
//      is the consequential one, and it is invisible in the output: the evicted entry leaves no
//      trace. If MAX_CANDIDATES ever binds tightly, this is the line to revisit first.
//   2. ROW ORDER  (`rows.sort((a, b) => b.stars - a.stars)`) — stars decide RANK. Anything
//      downstream that treats "top of CATALOG.md" as a merit signal inherits that.
//   3. DISPLAY    (the star cell in the table body) — the number is reported as a public fact
//      about the repo. Reporting a public number is not endorsing it; this one is fine as-is.
//
// Gates 1 and 2 grant a ranking privilege that a star count cannot actually evidence. Gate 3 does
// not. Keep them distinguished: if a future change wants to discount a star reading, it should
// neutralise RANK (e.g. order by the first-seen reading rather than the current one) and leave
// PRESENCE and DISPLAY untouched. Do not turn this file into a filter.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const curatedSlugs = new Set(curated.map((e) => e.slug.toLowerCase()));
const ranked = [...found.values()]
  .filter((it) => !curatedSlugs.has(it.full_name.toLowerCase()))
  .sort((a, b) => b.stargazers_count - a.stargazers_count);
// GATE 1 (see the note above): stars decide who gets checked at all.
const shortlist = ranked.slice(0, MAX_CANDIDATES);
if (ranked.length > shortlist.length) {
  console.log(`Capped at MAX_CANDIDATES=${MAX_CANDIDATES}: ${ranked.length - shortlist.length} lower-starred candidates not checked this run`);
}

// ---------------------------------------------------------------- command extraction

// A usable row needs a command someone can copy as-is. Placeholder paths and clone-first
// instructions are commands you have to edit before they work, so they do not count.
const CMD_RE = /^\s*(?:[-*>]\s*)?\$?\s*(dsh\s+plugin(?:\s+--profile\s+\S+)?(?:\s+-w)?\s+(?:add|install)\s+\S+.*?)\s*$/i;
const PLACEHOLDER =
  /[<>]|path\/to|\/Users\/|(?:^|[\s"'(])[A-Za-z]:[\\/]|%[A-Za-z_]+%|绝对路径|your[-_]|YOUR[-_]|\.\.\/|~\/|link:\.|file:/;

function selfRefScore(fullName, line) {
  const [owner, repo] = fullName.toLowerCase().split('/');
  const l = line.toLowerCase();
  let score = 0;
  if (l.includes(repo)) score += 2;
  if (l.includes(owner)) score += 1;
  const compact = repo.replace(/[-_.]/g, '');
  if (compact.length > 3 && l.replace(/[-_.]/g, '').includes(compact)) score += 1;
  return score;
}

function extractCommand(fullName, md) {
  const hits = [];
  for (const raw of md.split('\n')) {
    const m = raw.match(CMD_RE);
    if (!m) continue;
    const line = m[1].trim().replace(/\s+#.*$/, '');
    if (PLACEHOLDER.test(line)) continue;
    const spec = line.split(/\s+/).pop();
    if (/^\.{0,2}\//.test(spec)) continue; // local filesystem path
    hits.push({ line, score: selfRefScore(fullName, line) });
  }
  hits.sort((a, b) => b.score - a.score || a.line.length - b.line.length);
  return hits[0] && hits[0].score >= 2 ? hits[0].line : null;
}

// Some projects document their pinned ref as a shell variable (DSH_PLUGIN_REF=v2.4.0, then
// "github:owner/repo#${DSH_PLUGIN_REF}"). Substitute before matching so a correctly pinned entry
// is not read as drift. Same rule as verify-installs.mjs.
function expandVars(md) {
  const vars = new Map();
  for (const m of md.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=["']?([\w.@#/-]+)["']?\s*$/gm)) {
    vars.set(m[1], m[2]);
  }
  if (!vars.size) return md;
  return md.replace(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g, (all, name) => (vars.has(name) ? vars.get(name) : all));
}

let readFailures = 0;

async function fetchReadme(slug) {
  const r = await api(`https://api.github.com/repos/${slug}/readme`);
  if (!r.ok) {
    readFailures++;
    console.log(`  could not read ${slug}'s README (HTTP ${r.status})`);
    return null;
  }
  const j = await r.json();
  return expandVars(Buffer.from(j.content, 'base64').toString('utf8'));
}

// ---------------------------------------------------------------- screenshots (data capture only)

// Collected now, displayed nowhere. CATALOG.md stays a text table; an image strip built from
// whatever a README happens to contain would be a wall of broken and mismatched art, which is the
// empty-state rule in reverse. This just future-proofs the data for a consumer that does not exist
// yet, so the discipline is: only URLs the project itself published, only GitHub-hosted, never a
// guess and never a hotlink to someone else's image host.
const GH_IMAGE_HOST =
  /^https:\/\/(raw\.githubusercontent\.com\/|user-images\.githubusercontent\.com\/|camo\.githubusercontent\.com\/|private-user-images\.githubusercontent\.com\/|repository-images\.githubusercontent\.com\/|github\.com\/user-attachments\/)/;
const MAX_SHOTS = 4;

// A repo's social preview counts only when the maintainer uploaded one. GitHub serves an
// auto-generated card (opengraph.githubassets.com) for every other repo, and that card is a
// rendered title block, not a screenshot. usesCustomOpenGraphImage is the only honest way to tell
// them apart, and it exists on the GraphQL API only.
async function fetchOgImages(slugs) {
  const out = new Map();
  if (!TOKEN) return out;
  for (let i = 0; i < slugs.length; i += 50) {
    const batch = slugs.slice(i, i + 50);
    const query = `query {${batch
      .map(
        (s, n) =>
          ` r${n}: repository(owner:${JSON.stringify(s.split('/')[0])}, name:${JSON.stringify(
            s.split('/')[1]
          )}) { openGraphImageUrl usesCustomOpenGraphImage }`
      )
      .join('')} }`;
    let r;
    try {
      r = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
    } catch {
      console.log('  social-preview lookup failed (network), continuing without it');
      return out;
    }
    if (!r.ok) {
      console.log(`  social-preview lookup unavailable (HTTP ${r.status}), continuing without it`);
      return out;
    }
    const j = await r.json();
    batch.forEach((slug, n) => {
      const d = j.data && j.data[`r${n}`];
      if (d && d.usesCustomOpenGraphImage && GH_IMAGE_HOST.test(d.openGraphImageUrl || '')) {
        out.set(slug, d.openGraphImageUrl);
      }
    });
  }
  return out;
}

// Images the project's own README points at. Relative paths are resolved against the repo's default
// branch, which is where the README already says the file lives; nothing is fabricated.
function extractImages(slug, md) {
  if (!md) return [];
  const found = [];
  const add = (raw) => {
    if (!raw) return;
    let u = raw.trim().replace(/^<|>$/g, '').replace(/["')]+$/, '').split(/\s+/)[0];
    if (!u || u.startsWith('#') || u.startsWith('data:') || u.startsWith('mailto:')) return;
    if (/^https?:\/\//i.test(u)) {
      if (!GH_IMAGE_HOST.test(u)) return; // third-party image host, never hotlink it
    } else {
      if (/^\/\//.test(u)) return; // protocol-relative, host unknown
      u = `https://raw.githubusercontent.com/${slug}/HEAD/${u.replace(/^\.?\//, '')}`;
    }
    if (!found.includes(u)) found.push(u);
  };
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) add(m[1]);
  for (const m of md.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  return found.slice(0, MAX_SHOTS);
}

// ---------------------------------------------------------------- verify + assemble

const rows = [];
const dropped = { unresolved: 0, archived: 0, renamed: 0, noCommand: 0 };

async function run(items, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

// Curated README entries: keep the curated one-liner and command, re-resolve the repo, and mark
// the command verified only when the project's own README still contains its package spec.
await run(curated, async (e) => {
  const r = await api(`https://api.github.com/repos/${e.slug}`);
  if (!r.ok) return void dropped.unresolved++;
  const j = await r.json();
  if (j.archived) return void dropped.archived++;
  if (j.full_name.toLowerCase() !== e.slug.toLowerCase()) return void dropped.renamed++;

  const md = await fetchReadme(e.slug);
  let verified = false;
  if (e.cmd && /^dsh\s+plugin/i.test(e.cmd) && md) {
    let tok = e.cmd.split(/\s+/).pop().replace(/^['"]|['"]$/g, '');
    if (/^https:\/\/github\.com\//.test(tok)) tok = tok.split('/').slice(-2).join('/');
    verified = md.includes(tok);
  }
  rows.push({
    name: e.name,
    slug: j.full_name,
    blurb: e.headline || j.description || '',
    stars: j.stargazers_count,
    cmd: e.cmd,
    verified,
    shots: extractImages(j.full_name, md),
    section: e.section,
    curated: true,
  });
});

// Discovered repos: the command has to come out of the project's own README, so a row here is
// verified by construction.
await run(shortlist, async (it) => {
  const md = await fetchReadme(it.full_name);
  if (!md) return void dropped.unresolved++;
  const cmd = extractCommand(it.full_name, md);
  if (!cmd) return void dropped.noCommand++;
  rows.push({
    name: it.full_name.split('/')[1],
    slug: it.full_name,
    blurb: it.description || '',
    stars: it.stargazers_count,
    cmd,
    verified: true,
    shots: extractImages(it.full_name, md),
    curated: false,
  });
});

// One batched pass, after the rows exist, so a repo with a real uploaded social preview leads with
// it and README images fill in behind.
const og = await fetchOgImages(rows.map((r) => r.slug));
for (const r of rows) {
  const lead = og.get(r.slug);
  r.shots = (lead ? [lead, ...r.shots.filter((u) => u !== lead)] : r.shots).slice(0, MAX_SHOTS);
}
console.log(
  `Screenshots collected: ${rows.filter((r) => r.shots.length).length}/${rows.length} rows have at least one ` +
    `(${og.size} from an uploaded social preview). Data capture only, CATALOG.md is unchanged.`
);

// GATE 2 (see the note above): stars become rank here.
rows.sort((a, b) => b.stars - a.stars || a.slug.localeCompare(b.slug));

console.log(
  `Rows: ${rows.length} (${rows.filter((r) => r.curated).length} curated, ${rows.filter((r) => !r.curated).length} discovered). ` +
    `Dropped: ${dropped.unresolved} unresolved, ${dropped.archived} archived, ${dropped.renamed} renamed, ${dropped.noCommand} no self-referential install command.`
);

if (rows.length < curated.length) {
  console.error(`Refusing to write a catalog smaller than the curated list (${rows.length} < ${curated.length}).`);
  process.exit(1);
}

// A README we could not read is an unknown, not a failed check. A handful is normal API weather; a
// pile of them means the run is unreliable and would publish false "unverified" marks.
const readFailureBudget = Math.max(5, Math.round(rows.length * 0.05));
console.log(`README reads that failed: ${readFailures} (budget ${readFailureBudget})`);
if (readFailures > readFailureBudget) {
  console.error('Too many README reads failed. Keeping the existing catalog rather than publishing false unverified marks.');
  process.exit(1);
}

// ---------------------------------------------------------------- render

const esc = (s) =>
  String(s || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();

function oneLine(s, max = 120) {
  const t = esc(s);
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

// GATE 3 (see the note above): display only — deliberately left alone.
const stars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

const body = rows
  .map(
    (r) =>
      `| [${esc(r.name)}](https://github.com/${r.slug}) | ${oneLine(r.blurb)} | ${stars(r.stars)} | \`${esc(r.cmd)}\` | ${r.verified ? '✅' : '—'} |`
  )
  .join('\n');

const catalog = `# DSH plugin catalog

Auto-generated index of every DSH plugin this repo can resolve and install-check. The curated,
organized list is [README.md](README.md).

| Plugin | What it does | ★ | Install | ✅ |
|---|---|---|---|---|
${body}

<sub>${rows.length} plugins · same rows as data in [catalog.csv](catalog.csv) · rebuilt by
[\`build-catalog.mjs\`](.github/scripts/build-catalog.mjs) on every
[verify-installs](.github/workflows/verify-installs.yml) run · ✅ = the install command still appears in the
project's own README · edits here are overwritten, send them to [README.md](README.md).</sub>
`;

writeFileSync('CATALOG.md', catalog);
console.log(`Wrote CATALOG.md (${rows.length} plugins)`);

// The same rows as data, for anyone consuming the list programmatically. Full untruncated
// description, exact star count, RFC 4180 quoting.
const csvCell = (v) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// screenshots is semicolon-joined so the column stays one CSV field and splits without a parser.
const csv =
  ['name,description,stars,install_command,verified,repo_url,screenshots']
    .concat(
      rows.map((r) =>
        [r.name, r.blurb, r.stars, r.cmd, r.verified, `https://github.com/${r.slug}`, r.shots.join(';')]
          .map(csvCell)
          .join(',')
      )
    )
    .join('\n') + '\n';

writeFileSync('catalog.csv', csv);
console.log(`Wrote catalog.csv (${rows.length} rows)`);

// ---------------------------------------------------------------- plugins.json (registry feed)

// dsh-market's own schema, so a market user can point DSHM_REGISTRY_URL at this file and get our
// verified list instead of theirs. Their catalog is a static file too, so this raw URL is the whole
// endpoint. Fields we cannot fill honestly are left out rather than guessed; their type marks them
// optional and their code reads a missing value the same as null.

// An npm name only goes in when the package exists AND its own repository field points back at the
// repo we list. Anything looser attaches someone else's download count to our entry, which is the
// exact claim-jacking their contributing doc warns about.
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function npmSpecOf(cmd) {
  if (!cmd || !/^dsh\s+plugin/i.test(cmd)) return null;
  let tok = cmd.trim().split(/\s+/).pop().replace(/^['"]|['"]$/g, '').replace(/^npm:/, '');
  if (/^(github:|git\+|https?:|file:|link:|npm-|\.)/i.test(tok)) return null;
  const m = tok.match(/^((?:@[^@/]+\/)?[^@/]+)(?:@[^@]+)?$/);
  return m && NPM_NAME.test(m[1]) ? m[1] : null;
}

async function resolveNpm(rowsIn) {
  const out = new Map();
  let checked = 0;
  let rejected = 0;
  await run(rowsIn, async (r) => {
    const pkg = npmSpecOf(r.cmd);
    if (!pkg) return;
    checked++;
    let res;
    try {
      res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`, {
        headers: { 'User-Agent': H['User-Agent'] },
      });
    } catch {
      return;
    }
    if (!res.ok) return void rejected++;
    const j = await res.json();
    const repoField = j.repository && (j.repository.url || j.repository);
    const m = String(repoField || '').match(/github\.com[/:]([^/]+)\/([^/.#?]+)/i);
    const claims = m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
    if (claims && claims === r.slug.toLowerCase()) out.set(r.slug, pkg);
    else rejected++;
  });
  console.log(
    `npm linkage: ${out.size} of ${checked} npm-shaped install specs verified back to their own repo ` +
      `(${rejected} rejected: unpublished, or the package points at a different repository).`
  );
  return out;
}

const npmBySlug = await resolveNpm(rows);

// First-seen ledger. The GitHub API can tell us when a repo was created but not when WE first
// listed it, so this is recorded from now on and never back-dated.
const LEDGER = '.github/data/first-seen.json';
const today = new Date().toISOString().slice(0, 10);
let ledger = { _note: '', seen: {} };
try {
  const parsed = JSON.parse(readFileSync(LEDGER, 'utf8'));
  if (parsed && parsed.seen) ledger = parsed;
} catch {
  /* first run */
}
ledger._note =
  'When this catalog first listed each entry, keyed by owner/repo. Written by ' +
  '.github/scripts/build-catalog.mjs and never edited by hand. The ledger starts on 2026-08-24: ' +
  'every entry present that day carries that date because it is the first date we actually ' +
  'recorded, not the date we listed it. Nothing here is back-dated.';
let firstSeenNew = 0;
for (const r of rows) {
  if (!ledger.seen[r.slug]) {
    ledger.seen[r.slug] = today;
    firstSeenNew++;
  }
}
ledger.seen = Object.fromEntries(Object.entries(ledger.seen).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');

// Categories are the README's own section headings. A discovered row has no section, so it says so
// rather than being filed under a guess.
const UNSORTED = 'unsorted';
const categories = {};
for (const r of rows) {
  const key = r.section ? slugify(r.section) : UNSORTED;
  r.category = key;
  if (!categories[key]) categories[key] = { en: r.section || 'Unsorted' };
}

const REPO_URL = 'https://github.com/ZeroPointRepo/awesome-dsh-plugins';
const feed = {
  name: 'awesome-dsh-plugins',
  url: REPO_URL,
  source: REPO_URL,
  updated: today,
  count: rows.length,
  categories,
  plugins: rows.map((r) => {
    const [owner] = r.slug.split('/');
    const p = {
      name: r.name,
      owner,
      url: `https://github.com/${r.slug}`,
      category: r.category,
      description: { en: esc(r.blurb) },
      stars: r.stars,
      install: r.cmd || '',
      added: ledger.seen[r.slug],
    };
    const pkg = npmBySlug.get(r.slug);
    if (pkg) p.npm = pkg;
    if (r.shots.length) p.screenshots = r.shots;
    return p;
  }),
};

writeFileSync('plugins.json', JSON.stringify(feed, null, 2) + '\n');
console.log(
  `Wrote plugins.json (${rows.length} plugins, ${Object.keys(categories).length} categories, ` +
    `${firstSeenNew} newly added to the first-seen ledger)`
);

// The README's own numbers are NOT written here. build-readme-sections.mjs owns every count on
// the page and derives them offline from plugins.json and badges/verified.json, between markers.
// One number, one writer: this file used to rewrite the full-catalog line by matching its prose,
// which meant the sentence could not be reworded without silently disabling the refresh.
console.log(`plugins.json count is ${rows.length}; build-readme-sections.mjs writes it onto the page.`);
