import { fairShare, plainAverage } from "./rule.ts";
import type { Reports } from "./rule.ts";
import { toAmounts } from "./payout.ts";

export const MEMBERS = ["A", "B", "C", "D"];
export const TRUE_SPLIT = [40, 30, 20, 10];
export const POT_CENTS = 1_000_000n; // $10,000.00

/** The wow case: A, B, C are truthful, D (true 10%) lies. Plain average: D claims 100% for herself. Fair Share: D rates the others A 90 / B 5 / C 5. */
export function scenario() {
  const claims: Reports = TRUE_SPLIT.map((_, k) => (k === 3 ? [0, 0, 0, 100] : TRUE_SPLIT));
  const truthful = (k: number) => TRUE_SPLIT.map((v, j) => (j === k ? 0 : v));
  const rated: Reports = TRUE_SPLIT.map((_, k) => (k === 3 ? [90, 5, 5, 0] : truthful(k)));
  const plain = plainAverage(claims);
  const fair = fairShare(rated);
  return { plain, fair, plainCents: toAmounts(plain, POT_CENTS), fairCents: toAmounts(fair, POT_CENTS) };
}
