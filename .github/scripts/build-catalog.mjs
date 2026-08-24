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
const cStart = readme.indexOf('## The catalog');
const cEnd = readme.indexOf('## Good to know');
const catalogText = cStart >= 0 && cEnd > cStart ? readme.slice(cStart, cEnd) : readme;
const rLines = catalogText.split('\n');

const curated = [];
for (let i = 0; i < rLines.length; i++) {
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
  curated.push({ slug, name, cmd, headline, curated: true });
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

const curatedSlugs = new Set(curated.map((e) => e.slug.toLowerCase()));
const ranked = [...found.values()]
  .filter((it) => !curatedSlugs.has(it.full_name.toLowerCase()))
  .sort((a, b) => b.stargazers_count - a.stargazers_count);
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

// Keep the README's pointer line honest about the count.
const line = `- **Full catalog:** every verified DSH plugin (${rows.length}) in [CATALOG.md](CATALOG.md)`;
const updated = readme.replace(/^- \*\*Full catalog:\*\* every verified DSH plugin \(\d+\) in \[CATALOG\.md\]\(CATALOG\.md\)$/m, line);
if (updated !== readme) {
  writeFileSync('README.md', updated);
  console.log('Refreshed the README catalog count');
} else if (!readme.includes('CATALOG.md')) {
  console.error('README.md has no "Full catalog" line to update.');
  process.exit(1);
}
