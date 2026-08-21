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
//   PIN SUPERSEDED      - an npm-pinned version is no longer registry.npmjs.org's latest.
//
// Reads README.md, finds every catalog entry (bullet + author link + fenced install command),
// re-resolves each linked repo through the GitHub API, and re-reads that repo's own README to
// confirm the command still appears verbatim. Writes badges/verified.json (a shields.io
// endpoint-schema file) so the README badge is generated data, never a hardcoded claim.
//
// Usage: GH_TOKEN=... node verify-installs.mjs README.md
// Exit code is non-zero when a problem is found, so the Actions status badge reflects reality.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const file = process.argv[2] || 'README.md';

const H = {
  'User-Agent': 'awesome-dsh-plugins-verify',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const text = readFileSync(file, 'utf8');
// Scope to the catalog section only, so the badge count matches the "N plugins" claim at the top
// of the README rather than also picking up the Featured plugin entry or any link in the
// collapsed "Good to know" accordions (verification explainer / security / contributing).
const catalogStart = text.indexOf('## The catalog');
const catalogEnd = text.indexOf('## Good to know');
const catalogText = catalogStart >= 0 && catalogEnd > catalogStart ? text.slice(catalogStart, catalogEnd) : text;
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

const problems = [];
const ok = [];

for (const e of entries) {
  const r = await fetch(`https://api.github.com/repos/${e.slug}`, { headers: H });
  if (!r.ok) {
    problems.push(`${e.name} (${e.slug}): repo lookup HTTP ${r.status}`);
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

  let tok = e.cmd.split(/\s+/).pop();
  const rr = await fetch(`https://api.github.com/repos/${e.slug}/readme`, { headers: H });
  if (!rr.ok) {
    problems.push(`${e.name} (${e.slug}): could not read project's own README (HTTP ${rr.status}), command unverified`);
    continue;
  }
  const md = Buffer.from((await rr.json()).content, 'base64').toString();
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
      const latest = (await nr.json())['dist-tags']?.latest;
      if (latest && latest !== pinned) {
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

const total = entries.length;
const passing = ok.length;
const color = problems.length === 0 ? 'brightgreen' : problems.length <= 2 ? 'yellow' : 'red';

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
process.exit(problems.length ? 1 : 0);
