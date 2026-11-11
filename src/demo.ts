import { MEMBERS, TRUE_SPLIT, scenario } from "./scenario.ts";

const { plain, fair, plainCents, fairCents } = scenario();
const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(6);
const usd = (c: bigint) => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`.padStart(10);
console.log("Pot $10,000, true split 40/30/20/10. A, B, C are truthful; D (true 10%) lies.");
console.log("Plain average: D claims 100% for herself.   Fair Share: D can only rate the others (A 90, B 5, C 5).");
console.log("member    true   plain average        Fair Share");
MEMBERS.forEach((m, i) =>
  console.log(`${m}       ${pct(TRUE_SPLIT[i] / 100)}   ${pct(plain[i])} ${usd(plainCents[i])}   ${pct(fair[i])} ${usd(fairCents[i])}`),
);
console.log(`total             100%   ${usd(plainCents.reduce((a, b) => a + b))}          ${usd(fairCents.reduce((a, b) => a + b))}`);
