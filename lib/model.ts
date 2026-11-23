// Token launch radar, model v2 ("category-calibrated").
//
// The board ranks pre-token protocols by an implied value that is derived
// from the snapshot itself, never from a hand-written list of names:
//
//   multiple   = median FDV/TVL of the token protocols in the same category
//                (at least 4 of them; otherwise the global median), clamped
//                to [0.05, 3.00]
//   base       = tvl_usd * multiple
//   growth     = clamp(change_7d, -50, +100) per cent
//   growthMult = 1 + growth/100 * 0.40
//   maturity   = 0.70 + min(age_days, 730) / 730 * 0.30
//                (age unknown: 365 days)
//   implied    = max(1, round(base * growthMult * maturity))
//
// A protocol is pre-token when its record carries no market cap, no
// CoinGecko id and no symbol. The board covers the snapshot's whole
// watchlist and adds the 160 highest-TVL pre-token protocols below the
// watchlist floor. Protocols whose token already trades are kept apart in
// a "live" view, valued at their market cap, never mixed into the ranking.
//
// Deterministic: no clock, no randomness. Age is measured from the
// snapshot's own as_of date, and every tie breaks on the slug.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, printed in the dashboard's method section. */
export interface ModelParams {
  min_category_sample: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  early_rows: number;
  live_rows: number;
}

export const MODEL: ModelParams = {
  min_category_sample: 4,
  multiple_floor: 0.05,
  multiple_cap: 3.0,
  growth_weight: 0.4,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 730,
  unknown_age_days: 365,
  early_rows: 160,
  live_rows: 20,
};

export const MODEL_VERSION = 'radar-2-category';

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers (mean of the two middles when even). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The FDV/TVL multiple each category earns, from the token protocols the
 * snapshot itself carries. A category needs at least `min_category_sample`
 * token protocols; anything thinner falls back to the global median. The
 * result is clamped so one wild outlier cannot set a whole category.
 */
export function categoryMultiples(
  snapshot: Snapshot,
  model: ModelParams = MODEL,
): { byCategory: Record<string, { multiple: number; sample: number }>; global: number } {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    allRatios.push(ratio);
    const key = p.category ?? 'Uncategorized';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(ratio);
    ratiosByCategory.set(key, list);
  }
  const global = Math.min(model.multiple_cap, Math.max(model.multiple_floor, median(allRatios)));
  const byCategory: Record<string, { multiple: number; sample: number }> = {};
  for (const [key, ratios] of [...ratiosByCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const multiple =
      ratios.length >= model.min_category_sample
        ? Math.min(model.multiple_cap, Math.max(model.multiple_floor, median(ratios)))
        : global;
    byCategory[key] = { multiple: Math.round(multiple * 1e4) / 1e4, sample: ratios.length };
  }
  return { byCategory, global: Math.round(global * 1e4) / 1e4 };
}

/** The multiple one protocol's category earns (global when its category is thin). */
export function multipleFor(
  p: SnapshotProtocol,
  multiples: { byCategory: Record<string, { multiple: number; sample: number }>; global: number },
  model: ModelParams = MODEL,
): number {
  const entry = multiples.byCategory[p.category ?? 'Uncategorized'];
  if (entry !== undefined && entry.sample >= model.min_category_sample) return entry.multiple;
  return multiples.global;
}

/** The multipliers and implied value one protocol gets under the model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  multiples: { byCategory: Record<string, { multiple: number; sample: number }>; global: number },
  model: ModelParams = MODEL,
): {
  implied: number;
  multiple: number;
  base: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, p.listed_at);
  const multiple = multipleFor(p, multiples, model);
  const base = p.tvl_usd * multiple;
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, multiple, base: Math.round(base), growthPct, growthMult, maturityMult, age };
}

/** A name ending in a release marker is a versioned pool of another protocol. */
const VERSIONED_NAME = /\s(v\d+(\.\d+)?|V\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol's record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol may be ranked: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    base_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_multiple: number;
  base_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelParams;
  model_version: string;
  global_multiple: number;
  multiples: Record<string, { multiple: number; sample: number }>;
  watchlist_size: number;
  watchlist_slugs: string[];
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One step as a single string: action, then cost and time, within 20..600 chars. */
export function stepText(step: FarmStep): string {
  let s = `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
}

/**
 * The two legs of the farm, by what the protocol does. The dispatch reads
 * the category the snapshot carries, never a protocol's name.
 */
function mainActions(p: SnapshotProtocol, capital: number, chain: string): [string, string] {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return [
      `Supply $${capital} of USDC to ${name} on ${chain} as collateral and keep the supply position open.`,
      `Borrow a small amount against that supply, about 30% of its value, and repay it within a week to show both sides of the market.`,
    ];
  }
  if (c.includes('dex')) {
    return [
      `Add $${capital} of liquidity to ${name}'s main pool on ${chain}, split evenly between the two tokens the pool asks for.`,
      `If the pool offers a concentrated range, set a narrow band around the current price and collect the trading fees it earns.`,
    ];
  }
  if (c.includes('yield')) {
    return [
      `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and take the vault shares it issues.`,
      `Leave the vault's yield compounding instead of claiming it, so the position keeps growing without extra transactions.`,
    ];
  }
  if (c.includes('staking') || c.includes('restak')) {
    return [
      `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and hold the receipt token it mints.`,
      `Put that receipt token to work in one lending market on ${chain}, so the same capital is staked and supplied at once.`,
    ];
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option')) {
    return [
      `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small position, no more than a fifth of the margin.`,
      `Open a matching hedge on a second venue, so a sharp move in either direction leaves the position near flat.`,
    ];
  }
  if (c.includes('bridge')) {
    return [
      `Bridge $${capital} of USDC to ${chain} through ${name} and keep the bridged funds on the destination chain.`,
      `Use the bridged funds in one app on ${chain}, for example a swap or a deposit, so the bridge is not the only action.`,
    ];
  }
  if (c.includes('rwa')) {
    return [
      `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet.`,
      `Check the asset's redemption window and keep the position until at least one yield distribution has landed.`,
    ];
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return [
      `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares for the whole farming period.`,
      `Follow the vault's allocation updates and move the deposit only when the curator announces a new strategy.`,
    ];
  }
  if (c.includes('basis')) {
    return [
      `Deposit $${capital} into ${name}'s delta-neutral strategy on ${chain}, so the position earns the funding spread.`,
      `Check the strategy's funding rate once a week and exit if it stays negative for two weeks in a row.`,
    ];
  }
  if (c.includes('stable')) {
    return [
      `Mint or wrap $${capital} of the stable asset through ${name} on ${chain} and hold it in the farming wallet.`,
      `Use the wrapped stable in one low-risk pool on ${chain}, so the position earns yield while it waits.`,
    ];
  }
  if (c.includes('insurance')) {
    return [
      `Buy $${capital} of cover from ${name} on ${chain} for a protocol you already use, and keep the policy active.`,
      `Walk through the cover's claim flow once, so you know what proof a real claim would need.`,
    ];
  }
  if (c.includes('prediction')) {
    return [
      `Fund $${capital} on ${name} on ${chain} and take one position in a market that settles within the month.`,
      `Take a second, smaller position on the opposite side of a different market, to stay active without doubling the risk.`,
    ];
  }
  if (c.includes('chain') || c === '') {
    return [
      `Stake $${capital} of the chain's native token through ${name} and keep the stake delegated for the whole period.`,
      `Bridge a small amount to the chain and use one of its native apps, so the wallet shows activity beyond staking.`,
    ];
  }
  if (c.includes('payment')) {
    return [
      `Hold a $${capital} balance with ${name} on ${chain} and use it for at least one real payment a week.`,
      `Keep the payment history in the same wallet, so the activity is easy to show later.`,
    ];
  }
  if (c.includes('governance')) {
    return [
      `Lock or delegate $${capital} of voting power through ${name} on ${chain} and vote in the next proposal.`,
      `Vote in at least two proposals during the farming period, instead of voting once and going quiet.`,
    ];
  }
  if (c.includes('index')) {
    return [
      `Buy $${capital} of ${name}'s index token on ${chain} and hold it for the whole period.`,
      `Rebalance only when the index itself rebalances, so the position tracks the index instead of your own trades.`,
    ];
  }
  if (c.includes('launchpad')) {
    return [
      `Stake $${capital} through ${name} on ${chain} to qualify for its next token allocation.`,
      `Register for the next sale the launchpad announces and complete its checks before the sale opens.`,
    ];
  }
  return [
    `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the whole period.`,
    `Make one extra deposit halfway through the period, to show the position is still growing.`,
  ];
}

/** The risk to watch, by what the protocol does. */
function riskNote(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return 'Watch the loan health factor: repay or add collateral if it falls near the liquidation line.';
  }
  if (c.includes('dex')) {
    return 'Watch impermanent loss: if one side of the pair moves far, the pool trails simply holding the tokens.';
  }
  if (c.includes('staking') || c.includes('restak')) {
    return 'Slashing and unbonding delays apply: check the unbonding period before you stake.';
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option')) {
    return 'Leverage cuts both ways: keep the position small and never add margin to a losing trade.';
  }
  if (c.includes('bridge')) {
    return 'Bridges carry smart-contract and delay risk: bridge only what you can afford to wait for.';
  }
  if (c.includes('rwa')) {
    return 'The yield asset depends on its off-chain backing: read the attestation before you mint.';
  }
  if (c.includes('basis')) {
    return 'A funding rate can flip sign: the strategy earns only while the spread stays positive.';
  }
  if (c.includes('stable')) {
    return 'A wrapped stable is only as good as its peg and its backing: check both before you mint.';
  }
  return 'Smart-contract risk applies to every step: never farm with money you cannot afford to lose.';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a
 * time, derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const [first, second] = mainActions(p, capital, chain);
  const gas = capital >= 250 ? 8 : 4;
  return [
    {
      action: 'Set up a fresh wallet that holds only the funds you plan to farm, and store its seed phrase offline on paper.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    { action: first, cost: `$${capital} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
    { action: second, cost: `about $${Math.max(2, Math.round(gas / 2))} of gas`, time: '10 minutes' },
    {
      action: 'Do one qualifying action every week, such as a deposit, a swap, a vote or a borrow, so the wallet stays active in the protocol snapshots.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      action: `Keep the position open for at least ${hold} days, so the activity is counted across more than one snapshot window.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      action: 'Before you withdraw, open the protocol own rewards page from the link it publishes and check whether any points or claim is live.',
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      action: `${riskNote(p)} Write the wallet address, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  multiples: { byCategory: Record<string, { multiple: number; sample: number }>; global: number },
  model: ModelParams = MODEL,
): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, model.early_rows);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, multiples, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: s.multiple,
      base_usd: s.base,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot, model: ModelParams = MODEL): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, model.live_rows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_multiple: row.model.base_multiple,
    base_usd: row.model.base_usd,
    growth_pct: row.model.growth_pct,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelParams = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const multiples = categoryMultiples(snapshot, model);
  const board = buildBoard(snapshot, multiples, model);
  const live = liveRows(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: multiples.global,
    multiples: multiples.byCategory,
    watchlist_size: snapshot.watchlist.length,
    watchlist_slugs: [...snapshot.watchlist],
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
  }
  return null;
}

/** The dashboard's whole dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
