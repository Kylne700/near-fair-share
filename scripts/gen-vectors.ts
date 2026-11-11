// Writes the parity vectors for `cargo test` (contract/tests/parity.rs): 9,000 seeded profiles with the answers of
// src/rule.ts and src/payout.ts. usage: node scripts/gen-vectors.ts <out.json>
import { writeFileSync } from "node:fs";
import { fairShare } from "../src/rule.ts";
import { toAmounts } from "../src/payout.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/gen-vectors.ts <out.json>");

let seed = 20261111; // mulberry32
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const dv = new DataView(new ArrayBuffer(8));
const bits = (x: number) => (dv.setFloat64(0, x), dv.getBigUint64(0).toString(16).padStart(16, "0"));

const rating = (kind: number, base: number) =>
  kind === 0 ? int(1, 1000) : kind === 1 ? Math.min(1_000_000, Math.floor(10 ** (rnd() * 6))) : Math.max(1, Math.round(base * (0.8 + 0.4 * rnd())));

const profiles = [];
for (let c = 0; c < 9000; c++) {
  const n = 4 + (c % 5); // 1,800 profiles for each n = 4..8
  const kind = Math.floor(c / 5) % 3; // uniform small | log-uniform up to 1e6 | noisy consensus
  const truth = Array.from({ length: n }, () => int(1, 5000));
  const ratings = Array.from({ length: n }, (_, k) => truth.map((t, j) => (j === k ? 0 : rating(kind, t))));
  const shares = fairShare(ratings);
  const pot = BigInt(int(0, 1)) ? BigInt(int(1, 1_000_000_000)) : BigInt(int(1, 999)) * 10n ** BigInt(int(0, 27)) + BigInt(int(0, 1_000_000));
  profiles.push({ ratings, pot: pot.toString(), shares: shares.map(bits), amounts: toAmounts(shares, pot).map(String) });
}
writeFileSync(out, JSON.stringify(profiles));
console.log(`wrote ${profiles.length} profiles to ${out}`);
