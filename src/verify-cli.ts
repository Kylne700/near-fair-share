// npm run verify -- <round> [--rpc <url>] [--contract <account>]   (defaults: sandbox/.last-run.json written by `npm run sandbox --keep`)
import { existsSync, readFileSync } from "node:fs";
import { checkRound } from "./chain.ts";
import { loadRound } from "./rpc.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const roundId = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const last = new URL("../sandbox/.last-run.json", import.meta.url);
const saved = existsSync(last) ? (JSON.parse(readFileSync(last, "utf8")) as { rpc: string; contract: string }) : undefined;
const rpc = flag("--rpc") ?? saved?.rpc;
const contract = flag("--contract") ?? saved?.contract;
if (!roundId || !rpc || !contract) {
  console.error("usage: npm run verify -- <round> --rpc <url> --contract <account>\n(or run `npm run sandbox -- --keep` first and leave it running)");
  process.exit(2);
}
let result: ReturnType<typeof checkRound>;
try {
  result = checkRound(await loadRound(rpc, contract, roundId));
} catch (e) {
  console.error(`cannot read round "${roundId}" from ${contract} at ${rpc}: ${e instanceof Error ? e.message.slice(0, 300) : e}`);
  process.exit(2);
}
const { match, checks } = result;
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
console.log(match ? `MATCH ${roundId}` : `MISMATCH ${roundId}`);
process.exit(match ? 0 : 1);
