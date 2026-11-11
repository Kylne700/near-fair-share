export const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * Turns shares into integer amounts that sum EXACTLY to pot (largest-remainder rounding, ties by member order).
 * Amounts can be 0n on tiny pots: skip those Transfers.
 */
export function toAmounts(shares: readonly number[], pot: bigint): bigint[] {
  if (pot < 0n) throw new RangeError("pot must be >= 0");
  if (shares.length === 0) throw new RangeError("no shares");
  let total = 0;
  for (const s of shares) {
    if (!(Number.isFinite(s) && s >= 0)) throw new RangeError("shares must be finite and >= 0");
    total += s;
  }
  if (Math.abs(total - 1) > 1e-9) throw new RangeError(`shares must sum to 1 (got ${total})`);
  // 2^53 fixed point is exact for any double in [0,1]; weights then divide the pot exactly in bigint
  const w = shares.map((s) => BigInt(Math.round(s * 2 ** 53)));
  const sumW = w.reduce((a, b) => a + b, 0n);
  const amounts = w.map((wi) => (pot * wi) / sumW);
  const rem = w.map((wi) => (pot * wi) % sumW);
  let left = pot - amounts.reduce((a, b) => a + b, 0n);
  const order = shares.map((_, i) => i).sort((a, b) => (rem[a] === rem[b] ? a - b : rem[a] > rem[b] ? -1 : 1));
  for (const i of order) {
    if (left === 0n) break;
    amounts[i] += 1n;
    left -= 1n;
  }
  return amounts;
}
