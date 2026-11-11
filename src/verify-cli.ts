// npm run verify -- <round> [--rpc <url>] [--contract <account>]
// Defaults: the kept local node (sandbox/.last-run.json, written by `npm run sandbox -- --keep`), else the NEAR testnet deployment in evidence/testnet/deployment.json.
import { existsSync, readFileSync } from "node:fs";
import { checkRound } from "./chain.ts";
import { loadRound } from "./rpc.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const roundId = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const defaults = ["../sandbox/.last-run.json", "../evidence/testnet/deployment.json"].map((f) => new URL(f, import.meta.url)).find(existsSync);
const saved = defaults ? (JSON.parse(readFileSync(defaults, "utf8")) as { rpc: string; contract: string }) : undefined;
const rpc = flag("--rpc") ?? saved?.rpc;
const contract = flag("--contract") ?? saved?.contract;
if (!roundId || !rpc || !contract) {
  console.error("usage: npm run verify -- <round> [--rpc <url> --contract <account>]\n(without flags: a kept sandbox node, else the testnet deployment in evidence/testnet/deployment.json)");
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
console.log(`reading contract ${contract} at ${rpc}`);
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
console.log(match ? `MATCH ${roundId}` : `MISMATCH ${roundId}`);
process.exit(match ? 0 : 1);
