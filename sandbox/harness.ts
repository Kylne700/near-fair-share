// A local NEAR node (near-workspaces, no accounts on any real network) with the Fair Share contract, a Sputnik DAO
// and four members. Shared by `npm run sandbox` (prints) and test/chain.test.ts (asserts).
import { randomBytes } from "node:crypto";
import { Worker } from "near-workspaces";
import type { NearAccount, TransactionResult } from "near-workspaces";
import { commitHash, daoPolicy, proposalDescription, transferKind } from "../src/chain.ts";
import type { SplitView } from "../src/chain.ts";
import { YOCTO_PER_NEAR as NEAR } from "../src/payout.ts";

export { NEAR };
export const CONTRACT_WASM = new URL("../contract/fair_share.wasm", import.meta.url).pathname;
/** The official Sputnik DAO v2 wasm from near-daos/sputnik-dao-contract (see vendor/README.md); override with SPUTNIK_WASM. */
export const SPUTNIK_WASM = process.env.SPUTNIK_WASM ?? new URL("../vendor/sputnikdao2.wasm", import.meta.url).pathname;
export const BOND = NEAR / 100n; // 0.01 NEAR proposal bond
export const ROUND_BOND = NEAR; // what each member pays at commit and gets back with a valid reveal
const GAS = 100n * 10n ** 12n;

// near-api-js prints each receipt's logs and failures itself; our own line per transaction carries the same information.
const quiet = (print: (...a: unknown[]) => void) => (...a: unknown[]) => (/^(Receipt|\tLog|\tFailure)/.test(String(a[0])) ? undefined : print(...a));
console.log = quiet(console.log.bind(console));
console.warn = quiet(console.warn.bind(console));

export type Log = (line: string) => void;
export interface World {
  worker: Worker;
  rpc: string;
  contract: NearAccount;
  dao: NearAccount;
  relay: NearAccount;
  /** the DAO's council and the default team: alice, bob, carol, dave */
  team: NearAccount[];
  log: Log;
}

/** Truthful ratings of a 40/30/20/10 team: everybody rates the OTHER three; 0 on the diagonal. */
export const TRUTH = [40, 30, 20, 10];
export const truthfulRows = () => TRUTH.map((_, k) => TRUTH.map((v, j) => (j === k ? 0 : v)));
/** D lies: instead of the truth D rates A 90, B 5, C 5. */
export const dLiesRows = () => truthfulRows().map((row, k) => (k === 3 ? [90, 5, 5, 0] : row));

export const tgas = (r: TransactionResult) => (Number(BigInt(r.gas_burnt)) / 1e12).toFixed(1);
export const txHash = (r: TransactionResult): string => (r.result as unknown as { transaction_outcome: { id: string } }).transaction_outcome.id;
const burnt = (r: TransactionResult) => r.outcomesWithId.reduce((a, o) => a + BigInt(o.outcome.tokens_burnt), 0n);

export async function startWorld(log: Log = () => {}): Promise<World> {
  const worker = await Worker.init();
  const root = worker.rootAccount;
  const sub = (name: string, near: bigint) => root.createSubAccount(name, { initialBalance: near * NEAR });
  const [alice, bob, carol, dave, relay, contract, dao] = [await sub("alice", 20n), await sub("bob", 20n), await sub("carol", 20n), await sub("dave", 20n), await sub("relay", 5n), await sub("fairshare", 10n), await sub("dao", 30n)];
  const ids = [alice, bob, carol, dave].map((a) => a.accountId);
  await contract.deploy(CONTRACT_WASM);
  await root.callRaw(contract, "new", {}, { gas: GAS });
  await dao.deploy(SPUTNIK_WASM);
  const init = await root.callRaw(dao, "new", { config: { name: "fair-share-team", purpose: "pays Fair Share splits", metadata: "" }, policy: daoPolicy(ids, BOND) }, { gas: GAS });
  if (init.failed) throw new Error("DAO init failed: " + init.receiptFailureMessages.join(" | "));
  const rpc = (worker.provider as unknown as { connection: { url: string } }).connection.url;
  log(`sandbox up: ${rpc}  contract ${contract.accountId} (${CONTRACT_WASM.split("/").pop()})  dao ${dao.accountId} (${SPUTNIK_WASM.split("/").pop()})`);
  return { worker, rpc, contract, dao, relay, team: [alice, bob, carol, dave], log };
}

type Finality = "optimistic" | "final";
const block = (w: World, finality: Finality) => (w.worker.provider as unknown as { block(q: { finality: Finality }): Promise<{ header: { height: number; timestamp_nanosec: string } }> }).block({ finality });

/** Block time of the newest block in ms: the contract's deadlines are measured against block time. */
export async function chainNowMs(w: World): Promise<number> {
  const b = await block(w, "optimistic");
  return Math.floor(Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n));
}

export const balanceOf = async (a: NearAccount) => BigInt((await a.balance()).total);

/** Poll the chain's block time (deadlines are measured against it) until it is past `ms`. */
export async function waitUntilChainPast(w: World, ms: number) {
  while ((await chainNowMs(w)) <= ms) await new Promise((r) => setTimeout(r, 500));
}

/** Call and log "label | tx hash | ok/FAILED | Tgas". */
export async function send(w: World, from: NearAccount, to: NearAccount, method: string, args: Record<string, unknown>, label: string, deposit = 0n) {
  const r = await from.callRaw(to, method, args, { gas: GAS, attachedDeposit: deposit });
  w.log(`${label.padEnd(34)} ${txHash(r)}  ${r.succeeded ? "ok    " : "FAILED"} ${tgas(r).padStart(5)} Tgas${r.succeeded ? "" : "  " + r.receiptFailureMessages.map((m) => m.match(/ERR_[A-Z_]+/)?.[0] ?? m.slice(0, 80)).join(",")}`);
  return r;
}

export const failedWith = (r: TransactionResult, code: string) => r.failed === true && r.receiptFailureMessages.some((m) => m.includes(code));
const label = (a: NearAccount) => a.accountId.split(".")[0];

/** n funded accounts for a bigger team (the default team has 4). */
export async function makeTeam(w: World, n: number, prefix = "m"): Promise<NearAccount[]> {
  const out: NearAccount[] = [];
  for (let i = 0; i < n; i++) out.push(await w.worker.rootAccount.createSubAccount(`${prefix}${i}`, { initialBalance: 5n * NEAR }));
  return out;
}

export async function createRound(w: World, roundId: string, pot: bigint, o: { team?: NearAccount[]; commitMs?: number; revealMs?: number } = {}) {
  const now = await chainNowMs(w);
  const members = (o.team ?? w.team).map((a) => a.accountId);
  return send(w, w.relay, w.contract, "create_round", { round_id: roundId, dao: w.dao.accountId, pot: pot.toString(), bond: ROUND_BOND.toString(), members, commit_until_ms: String(now + (o.commitMs ?? 600_000)), reveal_until_ms: String(now + (o.revealMs ?? 1_200_000)) }, `create_round ${roundId}`);
}

/** Anyone (default: the non-member relay) closes a round whose reveal deadline has passed. */
export const finalize = (w: World, roundId: string, from: NearAccount = w.relay) => send(w, from, w.contract, "finalize", { round_id: roundId }, `finalize ${roundId}`);

export const newSalt = () => randomBytes(8).toString("hex");

/** Member i seals rows[i]. Returns the salt, which the member keeps for the reveal. */
export async function commit(w: World, roundId: string, who: NearAccount, ratings: number[], salt = newSalt(), deposit = ROUND_BOND) {
  const r = await send(w, who, w.contract, "commit", { round_id: roundId, commitment: commitHash(roundId, who.accountId, ratings, salt) }, `commit ${label(who)}`, deposit);
  return { r, salt };
}
export async function reveal(w: World, roundId: string, who: NearAccount, ratings: number[], salt: string) {
  return send(w, who, w.contract, "reveal", { round_id: roundId, ratings, salt }, `reveal ${label(who)}`);
}

/** Everybody commits (in parallel), returns the salts. */
export const commitAll = (w: World, roundId: string, team: NearAccount[], rows: number[][]) => Promise.all(team.map((a, i) => commit(w, roundId, a, rows[i]))).then((rs) => rs.map((x) => x.salt));
export const revealAll = (w: World, roundId: string, team: NearAccount[], rows: number[][], salts: string[]) => Promise.all(team.map((a, i) => reveal(w, roundId, a, rows[i], salts[i])));

export async function runRound(w: World, roundId: string, rows: number[][], pot: bigint, team: NearAccount[] = w.team) {
  await createRound(w, roundId, pot, { team });
  const salts = await commitAll(w, roundId, team, rows);
  const reveals = await revealAll(w, roundId, team, rows, salts);
  return { salts, reveals, split: (await w.contract.view("get_split", { round_id: roundId })) as SplitView };
}

/** Let refund receipts land and wait until the node's FINAL block has caught up with the newest one (that is what `verify` reads). */
export async function settle(w: World) {
  await w.worker.provider.fastForward(6);
  const height = async (finality: Finality) => (await block(w, finality)).header.height;
  const head = await height("optimistic");
  for (let i = 0; (await height("final")) < head; i++) {
    if (i > 100) throw new Error("final block did not catch up in 30 s");
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** relay (not a member) adds one Transfer proposal per member with amount > 0; members vote until it executes. */
export async function payOut(w: World, roundId: string, split: SplitView, team: NearAccount[] = w.team) {
  const amounts = split.amounts.map(BigInt);
  const total = async (a: NearAccount) => BigInt((await a.balance()).total);
  await settle(w);
  const before = await Promise.all(team.map(total));
  const daoBefore = await total(w.dao);
  const spent = team.map(() => 0n);
  const proposalIds: number[] = [];
  for (let i = 0; i < team.length; i++) {
    if (amounts[i] === 0n) continue;
    const kind = transferKind(team[i].accountId, amounts[i]);
    const add = await send(w, w.relay, w.dao, "add_proposal", { proposal: { description: proposalDescription(roundId, split.hash, team[i].accountId), kind } }, `dao add_proposal -> ${label(team[i])}`, BOND);
    const id = Number(add.parseResult?.() ?? Buffer.from(add.SuccessValue ?? "", "base64").toString());
    proposalIds.push(id);
    for (let v = 0; v < team.length; v++) {
      const cur = (await w.dao.view("get_proposal", { id })) as { status: string };
      if (cur.status !== "InProgress") break;
      const r = await send(w, team[v], w.dao, "act_proposal", { id, action: "VoteApprove", proposal: kind }, `dao VoteApprove #${id} by ${label(team[v])}`);
      spent[v] += burnt(r);
    }
  }
  await settle(w);
  const after = await Promise.all(team.map(total));
  const daoAfter = await total(w.dao);
  // member balance change + the gas the member paid for votes = the amount, to the yocto
  const gained = after.map((a, i) => a - before[i] + spent[i]);
  return { proposalIds, gained, daoDelta: daoAfter - daoBefore, amounts };
}
