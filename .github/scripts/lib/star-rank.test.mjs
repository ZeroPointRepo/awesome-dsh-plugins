// Positive control for star-rank.mjs — exercises the REAL module, not a copy of its logic.
// All ids below are synthetic fixtures. The configured set lives in the environment, not here.
// Scenario is the actual exposure: a discovery cap, and an entry whose count is inflated far
// enough to consume the last slot and evict an honest lower-counted plugin.
import { rankUnknownIds, byStarRank, orderingStars, isRankUnknown } from './star-rank.mjs';
import assert from 'node:assert/strict';

const INFLATED_ID = '999000001'; // synthetic fixture id — never a real repo
const MAX_CANDIDATES = 3;                          // cap made tight so it actually binds
const candidates = [
  { slug: 'org/big-honest',    id: '111', stars: 900 },
  { slug: 'org/mid-honest',    id: '222', stars: 500 },
  { slug: 'someone/inflated',  id: INFLATED_ID, stars: 400 },  // outranks the honest one below
  { slug: 'org/small-honest',  id: '333', stars: 120 },        // <- the plugin that gets evicted
  { slug: 'org/tiny-honest',   id: '444', stars: 0 },
];
const cmp = (ids) => byStarRank({ id: (x) => x.id, stars: (x) => x.stars,
                                  tiebreak: (a, b) => a.slug.localeCompare(b.slug) }, ids);
const shortlist = (ids) => [...candidates].sort(cmp(ids)).slice(0, MAX_CANDIDATES).map((x) => x.slug);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log(`  PASS  ${name}`); pass++; }
                          catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; } };

console.log('\n=== 1. THE BUG REPRODUCES with no configuration (module inert) ===');
const none = rankUnknownIds({});
t('empty env => id set is empty (module is a no-op)', () => assert.equal(none.size, 0));
const before = shortlist(none);
console.log(`     shortlist(cap=${MAX_CANDIDATES}): ${before.join(', ')}`);
t('the inflated entry consumes a slot', () => assert.ok(before.includes('someone/inflated')));
t('THE HONEST PLUGIN IS EVICTED (this is the exposure)',
  () => assert.ok(!before.includes('org/small-honest')));

console.log('\n=== 2. THE FIX: the same id configured as rank-unknown ===');
const ids = rankUnknownIds({ CATALOG_RANK_UNKNOWN_IDS: `  ${INFLATED_ID} , 999000002 ` });
t('env parses both ids', () => assert.equal(ids.size, 2));
t('the id is recognised', () => assert.ok(isRankUnknown(INFLATED_ID, ids)));
const after = shortlist(ids);
console.log(`     shortlist(cap=${MAX_CANDIDATES}): ${after.join(', ')}`);
t('THE HONEST PLUGIN SURVIVES', () => assert.ok(after.includes('org/small-honest')));
t('the inflated entry no longer takes a slot', () => assert.ok(!after.includes('someone/inflated')));
t('honest entries keep their own relative order',
  () => assert.deepEqual(after, ['org/big-honest', 'org/mid-honest', 'org/small-honest']));

console.log('\n=== 3. PRESENCE and DISPLAY are untouched ===');
const fullOrder = [...candidates].sort(cmp(ids)).map((x) => x.slug);
t('every entry is still present in the ordering (nothing removed)',
  () => assert.equal(fullOrder.length, candidates.length));
t('the unknown entry is last, not absent',
  () => assert.equal(fullOrder[fullOrder.length - 1], 'someone/inflated'));
t('its displayed star value is NOT modified by the module',
  () => assert.equal(candidates.find((c) => c.id === INFLATED_ID).stars, 400));
t('ordering key is -1 but the row keeps its real number',
  () => assert.equal(orderingStars(INFLATED_ID, 400, ids), -1));

console.log('\n=== 4. a measured zero still outranks an unknown count ===');
t('0 stars beats unknown', () => assert.ok(orderingStars('444', 0, ids) > orderingStars(INFLATED_ID, 999999, ids)));

console.log('\n=== 5. inertness: unconfigured ordering is bit-for-bit unchanged ===');
const plainSort = [...candidates].sort((a, b) => b.stars - a.stars || a.slug.localeCompare(b.slug)).map((x) => x.slug);
t('with no env, module ordering == the original comparator',
  () => assert.deepEqual([...candidates].sort(cmp(none)).map((x) => x.slug), plainSort));

console.log(`\n${fail === 0 ? 'ALL CONTROLS PASS' : 'CONTROL FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
