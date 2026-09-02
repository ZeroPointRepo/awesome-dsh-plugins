// star-rank.mjs — what a published star count is allowed to DECIDE in this catalog.
//
// A star count is a purchasable number. Everywhere this catalog uses stars, it is using them for
// one of three different things, and they are not equivalent:
//
//   PRESENCE — whether an entry is in the catalog at all. Stars must never decide this. An entry
//              earns its row by having an install command that actually resolves; that is what
//              the verification step measures and what the ✅ column reports. NOTHING IN THIS
//              MODULE REMOVES AN ENTRY.
//   ORDER    — who ranks above whom, and (where discovery is capped) who gets checked at all.
//              This is the one that can take something away from a third party: a count that
//              outranks an honest lower-counted project pushes it down, and past a cap, out of
//              the run entirely, leaving no trace in the output.
//   DISPLAY  — the number printed in the table. Reporting a public number is not endorsing it,
//              so display is left exactly alone. NOTHING IN THIS MODULE CHANGES A DISPLAYED
//              NUMBER.
//
// This module narrows ORDER only. Some published counts cannot be read as measurements of
// anything. Rather than treat such a count as high, the catalog treats it as UNKNOWN: the entry
// keeps its row and its printed number, and sorts after every entry whose count is usable. An
// unknown count therefore cannot outrank an honest one and cannot take a discovery slot from it.
// A count of zero still outranks an unknown count, because zero is a measurement and unknown is
// not.
//
// The id set comes from the environment (CATALOG_RANK_UNKNOWN_IDS: comma- or space-separated
// numeric GitHub repo ids) and is EMPTY BY DEFAULT — with nothing configured every function here
// is an identity and ordering is bit-for-bit what it was before this module existed.
//
// Ids, never owner/name: a rename must not shed the treatment, and a rename is cheap.

/** Parse the configured id set. Empty (and therefore inert) unless the environment supplies one. */
export function rankUnknownIds(env = process.env) {
  return new Set(
    String(env.CATALOG_RANK_UNKNOWN_IDS || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
  );
}

/** True when this repo id's published count is not to be read as a measurement. */
export function isRankUnknown(id, ids) {
  return id != null && ids.size > 0 && ids.has(String(id));
}

/**
 * Sort key for ORDERING ONLY. Returns the count for a usable reading, or -1 for an unknown one,
 * which places it below every real count including zero. Never use this value for display.
 */
export function orderingStars(id, stars, ids) {
  return isRankUnknown(id, ids) ? -1 : Number(stars) || 0;
}

/**
 * Comparator: descending by ordering-stars, then by the caller's own tiebreak. Unknown-count
 * entries land together at the bottom and are ordered among themselves by the tiebreak alone —
 * ordering them by a number we have just declared unusable would put it straight back in charge.
 *
 *   items.sort(byStarRank({ id: (x) => x.id, stars: (x) => x.stars,
 *                           tiebreak: (a, b) => a.slug.localeCompare(b.slug) }, ids))
 */
export function byStarRank({ id, stars, tiebreak }, ids) {
  return (a, b) =>
    orderingStars(id(b), stars(b), ids) - orderingStars(id(a), stars(a), ids) ||
    (tiebreak ? tiebreak(a, b) : 0);
}
