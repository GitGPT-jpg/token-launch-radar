// Token launch radar, model v4 ("fitted").
//
// The board ranks pre-token protocols by an implied value fitted from the
// snapshot itself, never from a hand-written list of names:
//
//   implied = TVL x multiple x size x growth x maturity
//
// Every term is fitted on the snapshot's own token protocols (the 128 that
// record a market cap above zero), and every term is tested on held-out
// data before it is trusted:
//
//   multiple  = the category's median market-cap/TVL ratio, shrunk toward
//               the global median by a pseudo-count k that the fit chooses:
//               multiple = exp((n*log(median_cat) + k*log(median_global))
//               / (n + k)), clamped to [0.05, 3.00]. A thin category (n=1)
//               barely moves the global figure; a thick one (n=15) owns it.
//   size      = (TVL / $100M) ^ s, with s fitted. The snapshot's token
//               protocols show the ratio falls as TVL grows (a log-log slope
//               near -0.4 overall, -0.35 within a category), so giants are
//               marked down and the board is not a TVL table.
//   growth    = 1 + w_g * clamp(change_7d, -50, +100) / 100, with w_g fitted
//               on the token protocols alongside the other knobs.
//   maturity  = m0 + (1 - m0) * min(age, 730) / 730, with m0 fitted. Age
//               carries almost no signal on its own; the fit decides how
//               much of it survives, and the dashboard prints the number.
//
// The fit is a grid search that minimises the mean squared error of
// log(implied) against log(market cap) on the token protocols — but the
// knobs are chosen by held-out error, not in-sample error: every candidate
// is scored on five held-out folds (a deterministic hash split of the token
// protocols, folds A to E, each protocol held out exactly once), each time
// with the multiples table fitted on that fold's training protocols only,
// and the candidate with the lowest mean held-out error wins. The board
// uses the winning knobs with the table fitted on all of them, and the
// dashboard prints the held-out errors next to the previous model's errors
// on the same folds, so the improvement is checked, not claimed.
//
// Two more things the board carries, both from the snapshot alone:
//   token odds  = how often protocols like this one have a token: the
//               category's token rate and the age bucket's token rate,
//               each shrunk toward the global rate of 19%, blended 70/30.
//               It never moves the ranking; it tells the reader how likely
//               the launch this board is priced for actually is.
//   confidence  = what to trust: the evidence behind the row — the category
//               sample behind the multiple, whether the growth or the
//               listing date was missing, and whether the multiple hit its
//               clamp. The size adjustment is a fitted part of the model,
//               shown on the row's detail view, not an evidence gap, so it
//               does not move the level. A row with thin evidence says so
//               on its face.
//
// A protocol is pre-token when its record carries no market cap, no
// CoinGecko id and no symbol. The board covers the snapshot's whole
// watchlist and adds the 160 highest-TVL pre-token protocols below the
// watchlist floor. Protocols whose token already trades are kept apart in
// a "live" view, valued at their market cap, never mixed into the ranking.
//
// Deterministic: no clock, no randomness. Age is measured from the
// snapshot's own as_of date, the held-out split is a hash of the slug, and
// every tie breaks on the slug.

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
  growth_floor: number;
  growth_cap: number;
  maturity_days: number;
  unknown_age_days: number;
  size_reference_usd: number;
  early_rows: number;
  live_rows: number;
}

/** The fitted knobs: chosen by the grid search, not by hand. */
export interface FitParams {
  shrink_k: number;
  size_exponent: number;
  growth_weight: number;
  maturity_floor: number;
}

export const MODEL: ModelParams = {
  min_category_sample: 4,
  multiple_floor: 0.05,
  multiple_cap: 3.0,
  growth_floor: -50,
  growth_cap: 100,
  maturity_days: 730,
  unknown_age_days: 365,
  size_reference_usd: 100_000_000,
  early_rows: 160,
  live_rows: 20,
};

export const MODEL_VERSION = 'radar-4-fitted';

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `v` into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
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

/** FNV-1a 32-bit hash of a string: the deterministic held-out split. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
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

/** The token protocols the fit can learn from: a market cap above zero. */
export function fittableProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** One step as a single string: action, then cost and time, within 20..600 chars. */
export interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

export function stepText(step: FarmStep): string {
  let s = `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/** The log-ratio table a fit works from: per-category medians and the global one. */
export interface LogRatioTable {
  byCategory: Record<string, { logMedian: number; sample: number }>;
  globalLogMedian: number;
  globalMedian: number;
  count: number;
  zeroMcapExcluded: number;
}

export function logRatioTable(protocols: SnapshotProtocol[]): LogRatioTable {
  const ratiosByCategory = new Map<string, number[]>();
  const allLogs: number[] = [];
  let zeroMcapExcluded = 0;
  for (const p of protocols) {
    if (p.mcap_usd === null) continue;
    if (p.mcap_usd <= 0 || p.tvl_usd <= 0) {
      zeroMcapExcluded++;
      continue;
    }
    const logRatio = Math.log(p.mcap_usd / p.tvl_usd);
    if (!Number.isFinite(logRatio)) continue;
    allLogs.push(logRatio);
    const key = p.category ?? 'Uncategorized';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(logRatio);
    ratiosByCategory.set(key, list);
  }
  const globalLogMedian = median(allLogs);
  const byCategory: Record<string, { logMedian: number; sample: number }> = {};
  for (const [key, logs] of [...ratiosByCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    byCategory[key] = { logMedian: median(logs), sample: logs.length };
  }
  return {
    byCategory,
    globalLogMedian,
    globalMedian: Math.exp(globalLogMedian),
    count: allLogs.length,
    zeroMcapExcluded,
  };
}

/** The shrunk multiple one category earns under a pseudo-count `k`. */
export function shrunkMultiple(
  category: string | null,
  table: LogRatioTable,
  k: number,
  model: ModelParams = MODEL,
): { multiple: number; sample: number; clamped: boolean } {
  const entry = table.byCategory[category ?? 'Uncategorized'];
  const n = entry === undefined ? 0 : entry.sample;
  const catLog = entry === undefined ? table.globalLogMedian : entry.logMedian;
  const shrunkLog = n + k === 0 ? table.globalLogMedian : (n * catLog + k * table.globalLogMedian) / (n + k);
  const raw = Math.exp(shrunkLog);
  const multiple = clamp(raw, model.multiple_floor, model.multiple_cap);
  return { multiple: Math.round(multiple * 1e4) / 1e4, sample: n, clamped: raw !== multiple };
}

/**
 * The fitted multiple table: every category's shrunk multiple, the global
 * median, and which categories had to fall back toward it.
 */
export function categoryMultiples(
  snapshot: Snapshot,
  fit: FitParams,
  model: ModelParams = MODEL,
): {
  byCategory: Record<string, { multiple: number; sample: number; clamped: boolean; raw_median: number }>;
  global: number;
  table: LogRatioTable;
} {
  const table = logRatioTable(fittableProtocols(snapshot));
  const global = Math.round(
    clamp(table.globalMedian, model.multiple_floor, model.multiple_cap) * 1e4,
  ) / 1e4;
  const byCategory: Record<string, { multiple: number; sample: number; clamped: boolean; raw_median: number }> = {};
  const seen = new Set<string>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? 'Uncategorized';
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = table.byCategory[key];
    byCategory[key] = {
      ...shrunkMultiple(key, table, fit.shrink_k, model),
      raw_median: Math.round((entry === undefined ? table.globalMedian : Math.exp(entry.logMedian)) * 1e4) / 1e4,
    };
  }
  return { byCategory, global, table };
}

/** The multipliers and implied value one protocol gets under the fitted model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  multiples: { byCategory: Record<string, { multiple: number; sample: number; clamped: boolean; raw_median: number }>; global: number },
  fit: FitParams,
  model: ModelParams = MODEL,
): {
  implied: number;
  multiple: number;
  base: number;
  sizeMultiplier: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
  clamped: boolean;
} {
  const age = ageDays(asOf, p.listed_at);
  const entry = multiples.byCategory[p.category ?? 'Uncategorized'];
  const multiple = entry !== undefined ? entry.multiple : multiples.global;
  const clamped = entry !== undefined ? entry.clamped : false;
  const base = p.tvl_usd * multiple;
  const sizeMultiplier = Math.pow(p.tvl_usd / model.size_reference_usd, fit.size_exponent);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * fit.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    fit.maturity_floor +
    (1 - fit.maturity_floor) *
      (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days);
  const implied = Math.max(1, Math.round(base * sizeMultiplier * growthMult * maturityMult));
  return {
    implied,
    multiple,
    base: Math.round(base),
    sizeMultiplier,
    growthPct,
    growthMult,
    maturityMult,
    age,
    clamped,
  };
}

/** The previous model's fixed parameters, for the held-out comparison. */
export const V2_FIT: FitParams = {
  shrink_k: 1e9,
  size_exponent: 0,
  growth_weight: 0.4,
  maturity_floor: 0.7,
};

/**
 * The v2 multiple rule (category median when the category counts at least
 * four token protocols, else the global median), used only to score the
 * previous model on the same held-out folds.
 */
export function v2Multiple(
  category: string | null,
  table: LogRatioTable,
  model: ModelParams = MODEL,
): number {
  const entry = table.byCategory[category ?? 'Uncategorized'];
  const raw =
    entry !== undefined && entry.sample >= model.min_category_sample
      ? Math.exp(entry.logMedian)
      : table.globalMedian;
  return clamp(raw, model.multiple_floor, model.multiple_cap);
}

/** Log-implied value of a token protocol under a parameter set. */
function logImpliedFor(
  p: SnapshotProtocol,
  asOf: string,
  table: LogRatioTable,
  fit: FitParams,
  model: ModelParams,
  v2: boolean,
): number {
  const multiple = v2
    ? v2Multiple(p.category, table, model)
    : shrunkMultiple(p.category, table, fit.shrink_k, model).multiple;
  const sizeMultiplier = v2
    ? 1
    : Math.pow(p.tvl_usd / model.size_reference_usd, fit.size_exponent);
  const growthPct = clamp(finite(p.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthWeight = v2 ? V2_FIT.growth_weight : fit.growth_weight;
  const growthMult = 1 + (growthPct / 100) * growthWeight;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const matFloor = v2 ? V2_FIT.maturity_floor : fit.maturity_floor;
  const maturityMult =
    matFloor + (1 - matFloor) * (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days);
  return Math.log(Math.max(1, p.tvl_usd * multiple * sizeMultiplier * growthMult * maturityMult));
}

/** Mean squared log error of a parameter set on a list of token protocols. */
function fitError(
  protocols: SnapshotProtocol[],
  asOf: string,
  table: LogRatioTable,
  fit: FitParams,
  model: ModelParams,
  v2: boolean,
): number {
  let sum = 0;
  for (const p of protocols) {
    const err = logImpliedFor(p, asOf, table, fit, model, v2) - Math.log(p.mcap_usd!);
    sum += err * err;
  }
  return protocols.length === 0 ? Infinity : sum / protocols.length;
}

/** One held-out fold's scores, for the fitted model and for v2 on the same fold. */
export interface FoldScore {
  fold: string;
  n_train: number;
  n_valid: number;
  fitted: { median_abs_log_err: number; rmse_log: number; within_2x: number };
  v2: { median_abs_log_err: number; rmse_log: number; within_2x: number };
  fitted_params: FitParams;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;

/** Score one parameter set on one validation list. */
function scoreFold(
  valid: SnapshotProtocol[],
  asOf: string,
  table: LogRatioTable,
  fit: FitParams,
  model: ModelParams,
  v2: boolean,
): { median_abs_log_err: number; rmse_log: number; within_2x: number } {
  const errs = valid.map(
    (p) => Math.abs(logImpliedFor(p, asOf, table, fit, model, v2) - Math.log(p.mcap_usd!)),
  );
  const within = errs.filter((e) => e < Math.log(2)).length;
  return {
    median_abs_log_err: round3(median(errs)),
    rmse_log: round3(Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / Math.max(1, errs.length))),
    within_2x: round3(valid.length === 0 ? 0 : within / valid.length),
  };
}

/** Every candidate parameter set, in fixed grid order. The grid is finer
 * than v3's around the region the coarse grid preferred, and the growth
 * weight is allowed to fall to zero: the fit may find that seven-day
 * growth carries no signal, and the board then says so instead of
 * pretending otherwise. */
export function gridCombos(): FitParams[] {
  const combos: FitParams[] = [];
  for (const k of [0, 4, 8, 16, 32, 48, 64]) {
    for (const s of [-0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0]) {
      for (const w of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
        for (const m of [0.7, 0.8, 0.9, 1]) {
          combos.push({ shrink_k: k, size_exponent: s, growth_weight: w, maturity_floor: m });
        }
      }
    }
  }
  return combos;
}

/** The whole fit: held-out folds A and B, then the all-data parameters. */
export interface FitResult {
  params: FitParams;
  folds: FoldScore[];
  n_fitted: number;
  zero_mcap_excluded: number;
  global_median: number;
  fit_rmse_log: number;
}

/**
 * The whole fit. The knobs are chosen by held-out error, not by in-sample
 * error: every candidate is scored on five held-out folds (a deterministic
 * hash split, folds A to E, each token protocol held out exactly once),
 * each time with the table fitted on that fold's training protocols only.
 * The score is the mean squared log error over every held-out protocol,
 * each counted once — the folds are pooled, not averaged, so a small fold
 * does not count as much as a large one — and the candidate with the
 * lowest score wins. The board then uses the winning knobs with the table
 * fitted on all token protocols. Each fold also scores the previous model
 * on the same split, so the improvement is measured, not asserted.
 */
export function fitModel(snapshot: Snapshot, model: ModelParams = MODEL): FitResult {
  const fitted = fittableProtocols(snapshot);
  const table = logRatioTable(fitted);
  const foldNames = ['A', 'B', 'C', 'D', 'E'];
  const splits = [0, 1, 2, 3, 4].map((foldMod) => {
    const valid = fitted.filter((p) => fnv1a(p.slug) % 5 === foldMod);
    const train = fitted.filter((p) => fnv1a(p.slug) % 5 !== foldMod);
    return { foldMod, valid, train, trainTable: logRatioTable(train) };
  });
  let best: FitParams = { shrink_k: 4, size_exponent: -0.3, growth_weight: 0, maturity_floor: 1 };
  let bestScore = Infinity;
  for (const combo of gridCombos()) {
    // Pooled held-out error: every held-out protocol counted once.
    let sumSq = 0;
    let count = 0;
    for (const s of splits) {
      for (const p of s.valid) {
        const err =
          logImpliedFor(p, snapshot.as_of, s.trainTable, combo, model, false) - Math.log(p.mcap_usd!);
        sumSq += err * err;
        count++;
      }
    }
    const score = count === 0 ? Infinity : sumSq / count;
    if (score < bestScore) {
      bestScore = score;
      best = combo;
    }
  }
  const folds: FoldScore[] = splits.map((s) => ({
    fold: foldNames[s.foldMod]!,
    n_train: s.train.length,
    n_valid: s.valid.length,
    fitted: scoreFold(s.valid, snapshot.as_of, s.trainTable, best, model, false),
    v2: scoreFold(s.valid, snapshot.as_of, s.trainTable, V2_FIT, model, true),
    fitted_params: best,
  }));
  const fit_rmse_log = round3(Math.sqrt(fitError(fitted, snapshot.as_of, table, best, model, false)));
  return {
    params: best,
    folds,
    n_fitted: fitted.length,
    zero_mcap_excluded: snapshot.protocols.filter((q) => q.mcap_usd !== null && q.mcap_usd <= 0).length,
    global_median: round4(table.globalMedian),
    fit_rmse_log,
  };
}

/** Token odds: how often protocols like this one have a token. */
export interface OddsTable {
  globalRate: number;
  byCategory: Record<string, { tokened: number; total: number; rate: number }>;
  byAgeBucket: Record<string, { tokened: number; total: number; rate: number }>;
}

export function oddsTable(snapshot: Snapshot): OddsTable {
  const total = snapshot.protocols.length;
  const tokened = snapshot.protocols.filter((p) => p.mcap_usd !== null).length;
  const globalRate = total === 0 ? 0 : tokened / total;
  const byCategory: OddsTable['byCategory'] = {};
  const catCounts = new Map<string, { tokened: number; total: number }>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? 'Uncategorized';
    const c = catCounts.get(key) ?? { tokened: 0, total: 0 };
    c.total++;
    if (p.mcap_usd !== null) c.tokened++;
    catCounts.set(key, c);
  }
  for (const [key, c] of [...catCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // Pseudo-count of 5 at the global rate: a category with no token
    // protocols yet still gets a small honest rate instead of zero.
    const rate = (c.tokened + 5 * globalRate) / (c.total + 5);
    byCategory[key] = { tokened: c.tokened, total: c.total, rate: round3(rate) };
  }
  const buckets: Array<[string, (age: number | null) => boolean]> = [
    ['under 6 months', (a) => a !== null && a < 180],
    ['6 to 12 months', (a) => a !== null && a >= 180 && a < 365],
    ['1 to 2 years', (a) => a !== null && a >= 365 && a < 730],
    ['over 2 years', (a) => a !== null && a >= 730],
    ['listing date missing', (a) => a === null],
  ];
  const byAgeBucket: OddsTable['byAgeBucket'] = {};
  for (const [label, pred] of buckets) {
    const list = snapshot.protocols.filter((p) => pred(ageDays(snapshot.as_of, p.listed_at)));
    const t = list.filter((p) => p.mcap_usd !== null).length;
    const rate = (t + 10 * globalRate) / (list.length + 10);
    byAgeBucket[label] = { tokened: t, total: list.length, rate: round3(rate) };
  }
  return { globalRate: round3(globalRate), byCategory, byAgeBucket };
}

function ageBucketLabel(age: number | null): string {
  if (age === null) return 'listing date missing';
  if (age < 180) return 'under 6 months';
  if (age < 365) return '6 to 12 months';
  if (age < 730) return '1 to 2 years';
  return 'over 2 years';
}

/** One protocol's token odds, with the two rates behind it. */
export function tokenOdds(
  p: SnapshotProtocol,
  asOf: string,
  odds: OddsTable,
): { odds: number; categoryRate: number; ageRate: number; ageBucket: string } {
  const age = ageDays(asOf, p.listed_at);
  const bucket = ageBucketLabel(age);
  const cat = odds.byCategory[p.category ?? 'Uncategorized'];
  const categoryRate = cat === undefined ? odds.globalRate : cat.rate;
  const ageEntry = odds.byAgeBucket[bucket];
  const ageRate = ageEntry === undefined ? odds.globalRate : ageEntry.rate;
  const raw = 0.7 * categoryRate + 0.3 * ageRate;
  return {
    odds: round3(clamp(raw, 0.02, 0.9)),
    categoryRate,
    ageRate,
    ageBucket: bucket,
  };
}

/** What the reader should and should not trust about one row: the evidence
 * behind it, not the size of a fitted adjustment. The size multiplier is
 * shown on the row's detail view; it is part of the fitted model, not a
 * gap in the evidence, so it does not move the level. */
export interface Confidence {
  level: 'high' | 'medium' | 'low';
  flags: string[];
}

export function confidenceFor(
  p: SnapshotProtocol,
  v: {
    multiple: number;
    sizeMultiplier: number;
    growthPct: number;
    age: number | null;
    clamped: boolean;
  },
  sample: number,
  model: ModelParams = MODEL,
): Confidence {
  const flags: string[] = [];
  if (sample < model.min_category_sample) {
    flags.push(
      `thin evidence: only ${sample} token protocol${sample === 1 ? '' : 's'} in this category, so the multiple leans on the global median`,
    );
  }
  if (v.clamped) {
    flags.push('multiple hit the 0.05–3.00 clamp, so the raw figure was wilder than the board shows');
  }
  if (p.change_7d === null) {
    flags.push('7-day growth was not reported, so the model treats it as 0%');
  }
  if (p.change_7d !== null && (p.change_7d > model.growth_cap || p.change_7d < model.growth_floor)) {
    flags.push('7-day growth ran past the clamp, so the model uses the clamped figure');
  }
  if (v.age === null) {
    flags.push('listing date missing, so the age is assumed to be 365 days');
  }
  const level = flags.length === 0 ? 'high' : flags.length === 1 ? 'medium' : 'low';
  return { level, flags };
}

/** The gas token a chain settles fees in, for the wallet setup step. */
function gasToken(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes('solana')) return 'SOL';
  if (c.includes('bsc') || c.includes('bnb')) return 'BNB';
  if (c.includes('avalanche')) return 'AVAX';
  if (c.includes('polygon')) return 'POL';
  if (c.includes('tron')) return 'TRX';
  if (c.includes('near')) return 'NEAR';
  if (c.includes('aptos')) return 'APT';
  if (c.includes('sui')) return 'SUI';
  if (c.includes('cosmos') || c.includes('osmosis')) return 'ATOM';
  if (c.includes('fantom')) return 'FTM';
  if (c.includes('cronos')) return 'CRO';
  if (c.includes('bitcoin')) return 'BTC';
  return 'ETH';
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

/** The weekly action, by what the protocol does. */
function weeklyAction(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return 'Supply or borrow a small amount, so the wallet shows both sides of the lending market every week.';
  }
  if (c.includes('dex')) {
    return 'Make one small swap through the pool, so the wallet keeps appearing in its trading activity.';
  }
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) {
    return 'Top up the vault by a small amount or claim and re-deposit the yield, so the position keeps moving.';
  }
  if (c.includes('staking') || c.includes('restak')) {
    return 'Restake the staking rewards or move the receipt token to a second pool, so the stake keeps working.';
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option')) {
    return 'Close and reopen one small position, so the wallet shows recent trading without growing the risk.';
  }
  if (c.includes('bridge')) {
    return 'Bridge a small amount in either direction, so the wallet keeps a recent bridge on record.';
  }
  if (c.includes('rwa')) {
    return 'Check the yield distribution and mint a small top-up after it lands, so the position grows with the asset.';
  }
  if (c.includes('governance')) {
    return 'Vote in any open proposal, or delegate to an active voter, so the wallet stays visible in governance.';
  }
  if (c.includes('prediction')) {
    return 'Take one small position in a market that settles soon, so the wallet stays active in the market.';
  }
  return 'Do one qualifying action, such as a deposit, a swap, a vote or a borrow, so the wallet stays active in the protocol snapshots.';
}

/** What to check before withdrawing, by what the protocol does. */
function rewardsCheck(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Before you withdraw, open ${p.name}'s own rewards page from the link it publishes and check whether any supply or borrow points are live.`;
  }
  if (c.includes('dex')) {
    return `Before you withdraw, open ${p.name}'s own rewards page from the link it publishes and check whether the pool's incentive gauge is paying.`;
  }
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) {
    return `Before you withdraw, open ${p.name}'s own rewards page from the link it publishes and check whether the vault has a points program or a claim.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Before you withdraw, open ${p.name}'s own rewards page from the link it publishes and check the unbonding period and any staking points.`;
  }
  return `Before you withdraw, open ${p.name}'s own rewards page from the link it publishes and check whether any points or claim is live.`;
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
    return "The yield asset depends on its off-chain backing: read the attestation before you mint.";
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
      action: `Set up a fresh wallet on ${chain} that holds only the funds you plan to farm, fund it with a little ${gasToken(chain)} for gas, and store its seed phrase offline on paper.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    { action: first, cost: `$${capital} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
    { action: second, cost: `about $${Math.max(2, Math.round(gas / 2))} of gas`, time: '10 minutes' },
    {
      action: weeklyAction(p),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      action: `Keep the position open for at least ${hold} days, so the activity is counted across more than one snapshot window.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      action: rewardsCheck(p),
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

/** One sentence that sizes the farm up, from the row's own odds and evidence. */
export function farmVerdict(
  odds: number,
  confidence: 'high' | 'medium' | 'low',
  growthPct: number,
): string {
  const falling = growthPct < -20 ? ' TVL is falling fast, so keep the position small even if you farm it.' : '';
  if (odds >= 0.25 && confidence !== 'low') {
    return `Verdict: the strongest kind of case on this board — peers like this one usually have a token, and the numbers behind the value are solid.${falling}`;
  }
  if (odds >= 0.15) {
    return `Verdict: worth farming — the odds are real but not high, so a modest position is the right size.${falling}`;
  }
  if (odds >= 0.08) {
    return `Verdict: a long shot on the odds, but the implied value is large enough that a small position still makes sense.${falling}`;
  }
  return `Verdict: a lottery ticket — peers almost never have a token, so farm only what you would not miss.${falling}`;
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
  token_odds: number;
  odds_category_rate: number;
  odds_age_rate: number;
  odds_age_bucket: string;
  confidence: 'high' | 'medium' | 'low';
  confidence_flags: string[];
  farm_verdict: string;
  model: {
    base_multiple: number;
    base_usd: number;
    size_multiplier: number;
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
  token_odds: number;
  odds_category_rate: number;
  odds_age_rate: number;
  odds_age_bucket: string;
  confidence: 'high' | 'medium' | 'low';
  confidence_flags: string[];
  farm_verdict: string;
  base_multiple: number;
  base_usd: number;
  size_multiplier: number;
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
  multiples: Record<string, { multiple: number; sample: number; clamped: boolean; raw_median: number }>;
  fit: FitResult;
  odds: OddsTable;
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

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  multiples: { byCategory: Record<string, { multiple: number; sample: number; clamped: boolean; raw_median: number }>; global: number },
  fit: FitParams,
  odds: OddsTable,
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
    const v = impliedValue(p, snapshot.as_of, multiples, fit, model);
    const o = tokenOdds(p, snapshot.as_of, odds);
    const entry = multiples.byCategory[p.category ?? 'Uncategorized'];
    const conf = confidenceFor(p, v, entry !== undefined ? entry.sample : 0, model);
    return { p, ...v, odds: o, conf };
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
    token_odds: s.odds.odds,
    odds_category_rate: s.odds.categoryRate,
    odds_age_rate: s.odds.ageRate,
    odds_age_bucket: s.odds.ageBucket,
    confidence: s.conf.level,
    confidence_flags: s.conf.flags,
    farm_verdict: farmVerdict(s.odds.odds, s.conf.level, s.growthPct),
    model: {
      base_multiple: s.multiple,
      base_usd: s.base,
      size_multiplier: round4(s.sizeMultiplier),
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
    token_odds: row.token_odds,
    odds_category_rate: row.odds_category_rate,
    odds_age_rate: row.odds_age_rate,
    odds_age_bucket: row.odds_age_bucket,
    confidence: row.confidence,
    confidence_flags: row.confidence_flags,
    farm_verdict: row.farm_verdict,
    base_multiple: row.model.base_multiple,
    base_usd: row.model.base_usd,
    size_multiplier: row.model.size_multiplier,
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
  const fitResult = fitModel(snapshot, model);
  const multiples = categoryMultiples(snapshot, fitResult.params, model);
  const odds = oddsTable(snapshot);
  const board = buildBoard(snapshot, multiples, fitResult.params, odds, model);
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
    fit: fitResult,
    odds,
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
    if (!(r.token_odds >= 0 && r.token_odds <= 1)) return `${r.slug} has token odds ${r.token_odds}`;
    if (r.confidence !== 'high' && r.confidence !== 'medium' && r.confidence !== 'low') {
      return `${r.slug} has confidence ${r.confidence}`;
    }
  }
  return null;
}

/** The dashboard's whole dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
