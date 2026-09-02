#!/usr/bin/env node
// Verify every install command in this list against the plugin's OWN docs, every week.
//
// This is the product. Anyone can claim "verified" once, by hand, on launch day. The
// promise only means something if it is re-checked on a real cadence and the badge that
// reports it is driven by that re-check, not hand-set.
//
// What this catches that a link checker structurally cannot:
//   RENAMED / ARCHIVED  - the GitHub repo moved or was archived. A rename still returns
//                         HTTP 200, so a plain link check passes it clean forever.
//   COMMAND DRIFT       - the project's own README no longer contains the install command's
//                         package spec. A superseded pin (e.g. foo@1.2.3 when 2.0 is out)
//                         still resolves and still installs, so nothing else will ever flag it.
//   PIN SUPERSEDED      - an npm-pinned version no longer matches ANY registry.npmjs.org
//                         dist-tag (not just `latest`, which never moves onto a prerelease).
//
// Reads README.md, finds every catalog entry (bullet + author link + fenced install command),
// re-resolves each linked repo through the GitHub API, and re-reads that repo's own README to
// confirm the command still appears verbatim. Writes badges/verified.json (a shields.io
// endpoint-schema file) so the README badge is generated data, never a hardcoded claim.
//
// Usage: GH_TOKEN=... node verify-installs.mjs README.md
// Exit code is non-zero when a problem is found, so the Actions status badge reflects reality.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { scope } from './lib/markers.mjs';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const file = process.argv[2] || 'README.md';

const H = {
  'User-Agent': 'awesome-dsh-plugins-verify',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const text = readFileSync(file, 'utf8');
// Scope to the catalog markers only, so the badge count matches the "N plugins" claim at the top
// of the README rather than also picking up the Featured plugin entry or any link in the
// collapsed "Good to know" accordions (verification explainer / security / contributing).
// STRUCTURAL, BY MARKERS: the old heading window fell back to the whole README when a heading
// moved, which inflated the denominator with no fault reported anywhere. `scope` aborts instead.
const catalogText = scope(text, 'catalog', file);
const lines = catalogText.split('\n');

// An entry starts on a bold action line:
//   - **What it does for the reader** with
//     [name](https://github.com/owner/repo) by [author](author-url). Description. N★, LICENSE. **[tag]**
// followed shortly by a fenced code block holding the real command. The plugin's own repo link is
// the first github.com link in the block (the author link comes second). Entries whose command is
// not a `dsh`/`npx`/`curl` line are still checked for repo health, the command-drift check is
// skipped for them and noted as such.
const entries = [];
for (let i = 0; i < lines.length; i++) {
  if (!/^- \*\*/.test(lines[i])) continue;
  const start = i;
  // Scan forward a few lines to find this entry's name + repo link and its fenced command block.
  let name = null;
  let slug = null;
  let cmd = null;
  for (let j = start; j < Math.min(start + 10, lines.length); j++) {
    if (j > start && /^- \*\*/.test(lines[j])) break; // next entry started, no block for this one
    if (!slug) {
      const m = lines[j].match(/\[([^\]]+)\]\(https:\/\/github\.com\/([^/)]+)\/([^/)#]+)\)/);
      if (m) {
        name = m[1];
        slug = `${m[2]}/${m[3].replace(/\.git$/i, '')}`;
      }
    }
    if (/^\s*```/.test(lines[j])) {
      cmd = (lines[j + 1] || '').trim();
      break;
    }
  }
  if (!slug) continue;
  entries.push({ line: start + 1, name, slug, cmd });
}

console.log(`Parsed ${entries.length} catalog entries from ${file}\n`);

// The Starter combos section repeats install commands that already exist in the catalog, so a
// first install is one copy instead of three. A repeated command is a rot surface: the catalog
// copy is the one this script re-checks weekly and the one a maintainer repins, and nothing
// would ever notice the combo copy drifting away from it (the same failure mode refresh-stars.mjs
// exists to close for star figures). Assert the two agree, offline, before spending an API call.
// Deliberately kept out of `problems`: the install-checks badge counts catalog entries, and a
// stale duplicate is not one of them. It still fails the run.
const combosDrift = [];
{
  const isInstall = (l) => /^dsh\s+plugin\s/.test(l);
  const catalogCmds = new Set(catalogText.split('\n').map((l) => l.trim()).filter(isInstall));
  // Marker-scoped for the same reason the catalog is. The old version windowed from the combos
  // HEADING to the start of the catalog heading, so it read every section in between as combos.
  const combosText = scope(text, 'combos', file);
  const comboCmds = combosText.split('\n').map((l) => l.trim()).filter(isInstall);
  if (!comboCmds.length) {
    combosDrift.push('Starter combos section has a heading but no install commands');
  }
  for (const c of comboCmds) {
    if (!catalogCmds.has(c)) combosDrift.push(`"${c}" does not match any catalog command`);
  }
  console.log(`Starter combos: ${comboCmds.length} commands checked against the catalog\n`);
}

// Some projects document their pinned ref as a shell variable rather than inline:
//   DSH_PLUGIN_REF=v2.4.0
//   dsh plugin --profile web add "github:owner/repo#${DSH_PLUGIN_REF}"
// Substituting the assignments before matching is the difference between checking that pin and
// reporting a correctly pinned entry as drift.
function expandVars(md) {
  const vars = new Map();
  for (const m of md.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=["']?([\w.@#/-]+)["']?\s*$/gm)) {
    vars.set(m[1], m[2]);
  }
  if (!vars.size) return md;
  return md.replace(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g, (all, name) => (vars.has(name) ? vars.get(name) : all));
}

const problems = [];
const ok = [];
// THIRD STATE. A repo we could not reach is not a repo that failed its check. A broken
// credential (401), a rate limit (403/429), a GitHub outage (5xx) and a dead socket (0) are all
// "we could not look"; 404 stays a real finding, because a repo that is genuinely gone IS the
// thing this script exists to catch. Conflating the two is what published a red "0/81 passing"
// badge, and a fresh checked-at date, off a fully rate-limited run on 2026-08-31.
const unchecked = [];
const isTransport = (s) => s === 401 || s === 403 || s === 429 || s === 0 || s >= 500;

for (const e of entries) {
  const r = await fetch(`https://api.github.com/repos/${e.slug}`, { headers: H }).catch(() => ({ ok: false, status: 0 }));
  if (!r.ok) {
    (isTransport(r.status) ? unchecked : problems).push(`${e.name} (${e.slug}): repo lookup HTTP ${r.status}`);
    continue;
  }
  const j = await r.json();
  if (j.archived) {
    problems.push(`${e.name} (${e.slug}): ARCHIVED upstream`);
    continue;
  }
  if (j.full_name.toLowerCase() !== e.slug.toLowerCase()) {
    problems.push(`${e.name}: RENAMED, list points at ${e.slug}, now ${j.full_name} (line ${e.line})`);
    continue;
  }

  if (!e.cmd || !/^(dsh|npx|curl)\s/.test(e.cmd)) {
    ok.push(`${e.name}: repo healthy, no parseable command to re-check`);
    continue;
  }

  // The distinctive part of a dsh/npx command is its final token (the package/URL spec).
  // For a curl command (our two remote-MCP config files), check the file exists in-repo instead.
  if (/^curl\s/.test(e.cmd)) {
    ok.push(`${e.name}: repo healthy, remote-MCP config command (checked separately, see mcp-configs/)`);
    continue;
  }

  let tok = e.cmd.split(/\s+/).pop().replace(/^['"]|['"]$/g, '');
  const rr = await fetch(`https://api.github.com/repos/${e.slug}/readme`, { headers: H }).catch(() => ({ ok: false, status: 0 }));
  if (!rr.ok) {
    (isTransport(rr.status) ? unchecked : problems).push(`${e.name} (${e.slug}): could not read project's own README (HTTP ${rr.status}), command unverified`);
    continue;
  }
  const md = expandVars(Buffer.from((await rr.json()).content, 'base64').toString());
  // For a github.com archive/tarball URL, the owner segment can go stale after a rename
  // (the repo-health check above already catches that independently). What actually matters
  // here is whether the referenced tag/file still exists in the project's own docs, so match
  // on the filename suffix rather than the full URL when the token is a github.com link.
  if (/^https:\/\/github\.com\//.test(tok)) {
    tok = tok.split('/').slice(-2).join('/'); // e.g. "tags/v0.6.7.tar.gz"
  }
  if (!md.includes(tok)) {
    problems.push(`${e.name} (${e.slug}): command spec "${tok}" no longer appears in the project's own README (line ${e.line})`);
    continue;
  }

  // If the spec pins an npm version, check that pin is still current.
  const pin = tok.match(/^(@[\w.-]+\/[\w.-]+|[a-z0-9][\w.-]*)@([\d][\w.\-]*)$/i);
  if (pin) {
    const [, name, pinned] = pin;
    const nr = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`);
    if (nr.ok) {
      const tags = (await nr.json())['dist-tags'] ?? {};
      const latest = tags.latest;
      // A pin is current if it matches ANY published dist-tag, not just `latest`.
      // npm does not move `latest` onto a prerelease, so a package whose own README
      // documents `pkg@1.0.0-beta.2` sits under the `beta` tag while `latest` still
      // points at `beta.1`. Checking `latest` alone reported that as "pin superseded"
      // and would have pushed the list BACKWARDS onto a stale version to quiet the
      // check. Real case: dsh-dictation, 2026-08-31.
      const tagged = Object.values(tags).includes(pinned);
      if (latest && !tagged) {
        problems.push(`${name}: pin superseded, list has ${pinned}, npm latest is ${latest} (line ${e.line})`);
        continue;
      }
    }
  }

  ok.push(`${e.name}: command verified against ${e.slug}'s own README`);
}

console.log(`OK (${ok.length}):`);
ok.forEach((s) => console.log('  ' + s));
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  problems.forEach((s) => console.log('  ' + s));
}
if (unchecked.length) {
  console.log(`\nUNCHECKED (${unchecked.length}) — could not look, so no verdict claimed:`);
  unchecked.forEach((s) => console.log('  ' + s));
}
if (combosDrift.length) {
  console.log(`\nSTARTER COMBO DRIFT (${combosDrift.length}):`);
  combosDrift.forEach((s) => console.log('  ' + s));
}

const total = entries.length;
const passing = ok.length;
const color = problems.length === 0 ? 'brightgreen' : problems.length <= 2 ? 'yellow' : 'red';

// Never publish a verdict this run did not earn. Above 5% unreachable the badges are LEFT
// ALONE: last week's honest figure is strictly better than this week's fabricated one, and
// `checked-at` must never claim a date on which nothing was actually checked. Same ceiling,
// same reasoning as the catalog build and the star ledger.
if (unchecked.length / Math.max(total, 1) > 0.05) {
  console.log(
    `\nBADGES NOT WRITTEN: ${unchecked.length}/${total} entries (${((unchecked.length / total) * 100).toFixed(1)}%) were unreachable.\n` +
      'Leaving the previous badge and checked-at date in place — a run that could not look must not\n' +
      'publish "0 passing", and must not stamp today as the day the list was checked.'
  );
  process.exit(1);
}

mkdirSync('badges', { recursive: true });
writeFileSync(
  'badges/verified.json',
  JSON.stringify(
    {
      schemaVersion: 1,
      label: 'install checks',
      message: `${passing}/${total} passing`,
      color,
    },
    null,
    2
  ) + '\n'
);
writeFileSync(
  'badges/checked-at.json',
  JSON.stringify(
    {
      schemaVersion: 1,
      label: 'last checked',
      message: new Date().toISOString().slice(0, 10),
      color: 'blue',
    },
    null,
    2
  ) + '\n'
);

console.log(`\nWrote badges/verified.json (${passing}/${total}) and badges/checked-at.json`);
process.exit(problems.length || combosDrift.length || unchecked.length ? 1 : 0);
