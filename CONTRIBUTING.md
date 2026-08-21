# Contributing to Awesome DSH Plugins

Thanks for considering a contribution. We are strict about verification but fast about merging
(target under 7 days to a first response on every PR).

## A note on our own entries

The maintainer of this repository builds and sells developer tools:
[TranscriptAPI](https://transcriptapi.com), [StayingAPI](https://stayingapi.com), and
[Zillapi](https://zillapi.com). Two of them, TranscriptAPI and Zillapi, are listed in the
[Connect our own data APIs](README.md#connect-our-own-data-apis) section of this list, because both
have a working MCP server we wired into DSH and verified end to end.

When one of ours appears here:

- It follows the **exact same entry format** as everyone else's: no bold, no emoji, no "featured"
  styling.
- It sits **at most once per category**.
- It is held to a **higher** bar than contributed entries: no verified install path, no real docs, it
  does not go in. StayingAPI is not listed for exactly this reason (its key could not be verified
  live at the time of writing).
- We will **never reject or downrank a competing entry** to protect one of ours.
- Where it appears, it carries an inline disclosure: *(Maintainer's own — see this section.)*

## Adding a plugin entry

Open a PR that adds one entry, in the right category, in this exact format:

```
- **What it does for the reader, as a short action phrase** with
  [name](repo-url) by [author](author-url). A factual one-line description. N★, LICENSE. **[tag]**
  ```sh
  dsh plugin --profile <profile> add <package>
  ```
```

Tags: **production** (mature, widely installed) · **beta** (works, pre-1.0 or young) ·
**experimental** (early, worth watching).

### Acceptance bar (we merge if all of these are true)

1. **It installs.** A real `dsh plugin add` (or documented DSH-native equivalent, like the
   `--patch` config files this list uses for remote MCP servers) that you copied out of the
   project's **own** README or docs, not one you guessed. We will check it against that project's
   own documentation before merging, same as every existing entry.
2. **The GitHub repo resolves**, is not archived, and is not a same-named coincidence with an
   unrelated project.
3. **It is not already listed.**
4. **The category is right.** If it spans two, pick the primary use case; a maintainer will move it
   rather than bounce the PR over this alone.

We reject only for: no working install command, dead or archived link, no real substance, pure spam,
or exact duplicate. **We always reply**, even to a rejection, and we will say exactly what would get
a resubmission in.

An honestly empty category beats a padded one. If your plugin doesn't clear the bar yet, tell us and
we will note it in [What we left out](README.md#what-we-left-out) instead of listing a command that
doesn't work.

## Style

- One entry per line plus its command block, no sub-bullets beyond that.
- No affiliate links, no UTM parameters, no tracking redirects.
- Keep descriptions under about 120 characters where you can.
- No em dashes. Use a period, comma, or colon instead.
