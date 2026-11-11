// npm run testnet -- <accounts | deploy | round <id> [--silent] | links>      NEAR TESTNET only (free test tokens, nothing of value).
//   accounts  make a key per account (NEAR_PREFIX=<name>), fund it from the testnet faucet; keys stay in NEAR_KEYS_DIR, never printed
//   deploy    deploy contract/fair_share.wasm, create the team DAO with the official Sputnik v2 testnet factory
//   round     one full round: commit, reveal, split, DAO Transfer proposals, votes, payout, balances; --silent = the last member never reveals
//   links     open every explorer link in evidence/testnet/*.txt and say whether it answers
// Every transaction is waited to FINAL and written with its explorer link to evidence/testnet/<name>.txt. Then: npm run verify -- <id>
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, keyStores, KeyPair } from "near-api-js";
import { bitsToShare, checkRound, commitHash, daoPolicy, proposalDescription, shareBits, transferKind, wasmCodeHash } from "../src/chain.ts";
import { YOCTO_PER_NEAR as NEAR, toAmounts } from "../src/payout.ts";
import { fairShare, neutralRow } from "../src/rule.ts";
import { codeHash, loadRound, view } from "../src/rpc.ts";

const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const KEYS = (process.env.NEAR_KEYS_DIR ?? new URL("../.testnet-keys", import.meta.url).pathname).replace(/\/?$/, "/");
const EVIDENCE = new URL("../evidence/testnet/", import.meta.url).pathname;
const DEPLOYMENT = EVIDENCE + "deployment.json";
const FACTORY = "sputnikv2.testnet";
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const FAUCET = "https://helper.nearprotocol.com/account";
const GAS = 100n * 10n ** 12n;
const POT = NEAR; // 1 NEAR per round: testnet tokens, small on purpose
const ROUND_BOND = NEAR / 10n;
const DAO_BOND = NEAR / 100n;
const DAO_DEPOSIT = 9n * NEAR; // ~5.5 NEAR of it is the DAO's code storage; the rest is the pots
const NAMES = ["alice", "bob", "carol", "dave"];

interface Deployment { network: "testnet"; rpc: string; factory: string; contract: string; dao: string; relay: string; members: string[]; contractCodeHash: string; daoCodeHash: string; bond: string }
interface Outcome { transaction: { hash: string }; status: object | string; transaction_outcome: { outcome: { tokens_burnt: string } }; receipts_outcome: { outcome: { status: object | string; tokens_burnt: string } }[] }

const say = (s = "") => console.log(s);
function die(s: string): never {
  console.error(s);
  process.exit(2);
}
const [cmd, ...rest] = process.argv.slice(2);
const read = (p: string) => readFileSync(p, "utf8").trim();

const keyStore = new keyStores.InMemoryKeyStore();
// tsc 7 does not see networkId in near-api-js 5.1.1's ConnectConfig (it is required at runtime), hence the cast
const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore } as never);
const provider = near.connection.provider;
const keyPath = (id: string) => `${KEYS}${id}.key`;
const loadKey = async (id: string) => keyStore.setKey("testnet", id, KeyPair.fromString(read(keyPath(id)) as never));

const accountState = async (id: string) => provider.query({ request_type: "view_account", finality: "final", account_id: id }).then((a: unknown) => a as { amount: string }, () => null);
const balance = async (id: string) => BigInt((await accountState(id))?.amount ?? 0);
const near2 = (y: bigint) => (Number(y / 10n ** 15n) / 1e9).toFixed(6);
const nowMs = async () => Number(BigInt((await provider.block({ finality: "optimistic" })).header.timestamp_nanosec) / 1_000_000n);
async function waitPast(ms: number) {
  while ((await nowMs()) <= ms) await new Promise((r) => setTimeout(r, 3000));
}

let evidence = EVIDENCE + "setup.txt";
const note = (line: string) => (appendFileSync(evidence, line + "\n"), say(line));
const failed = (o: Outcome) => !/Success/.test(JSON.stringify(o.status)) || o.receipts_outcome.some((r) => "Failure" in (r.outcome.status as object));

/** Wait for FINAL, write "label | from -> call | hash | status | explorer link" to the evidence file, throw if anything in the tx failed. */
async function record(label: string, from: string, what: string, first: Outcome) {
  const hash = first.transaction.hash;
  const fin = (await provider.txStatus(hash, from, "FINAL")) as unknown as Outcome;
  const bad = failed(fin);
  note(`${label} | ${from} -> ${what} | ${hash} | ${bad ? "FAILED" : "success"} | ${EXPLORER}${hash}`);
  if (bad) throw new Error(`${label} failed: ${hash}`);
  const burnt = [fin.transaction_outcome, ...fin.receipts_outcome].reduce((a, o) => a + BigInt(o.outcome.tokens_burnt), 0n);
  const sv = (fin.status as { SuccessValue?: string }).SuccessValue ?? "";
  return { hash, value: Buffer.from(sv, "base64").toString(), burnt };
}
async function call(label: string, from: string, to: string, method: string, args: object, deposit = 0n, gas = GAS) {
  const out = await (await near.account(from)).functionCall({ contractId: to, methodName: method, args, gas, attachedDeposit: deposit });
  return record(label, from, `${to}.${method}`, out as unknown as Outcome);
}

const prefix = process.env.NEAR_PREFIX;
const ids = (p: string) => ({ contract: `${p}-contract.testnet`, relay: `${p}-relay.testnet`, members: NAMES.map((n) => `${p}-${n}.testnet`), daoName: `${p}-team` });
const deployment = () => (existsSync(DEPLOYMENT) ? (JSON.parse(read(DEPLOYMENT)) as Deployment) : die("no evidence/testnet/deployment.json: run `npm run testnet -- deploy` first"));

mkdirSync(EVIDENCE, { recursive: true });
if (cmd === "accounts") {
  if (!prefix || !/^[a-z0-9-]{3,30}$/.test(prefix)) die("set NEAR_PREFIX (3-30 chars of a-z 0-9 -), e.g. NEAR_PREFIX=fairshare-demo");
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const p = ids(prefix);
  for (const id of [p.contract, p.relay, ...p.members]) {
    if (!existsSync(keyPath(id))) writeFileSync(keyPath(id), KeyPair.fromRandom("ed25519").toString() + "\n", { mode: 0o600 });
    chmodSync(keyPath(id), 0o600);
    if (await accountState(id)) { say(`${id} exists, balance ${near2(await balance(id))} NEAR`); continue; }
    const pub = KeyPair.fromString(read(keyPath(id)) as never).getPublicKey().toString();
    const res = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: pub }) });
    const body = await res.text();
    const hash = (JSON.parse(body.startsWith("{") ? body : "{}") as { transaction?: { hash?: string } }).transaction?.hash;
    evidence = EVIDENCE + "setup.txt";
    note(`faucet creates ${id} | ${res.status} | ${hash ? `${hash} | ${EXPLORER}${hash}` : "no tx hash in the answer"}`);
    for (let i = 0; i < 20 && !(await accountState(id)); i++) await new Promise((r) => setTimeout(r, 3000));
    say(`${id}: ${(await accountState(id)) ? "created, balance " + near2(await balance(id)) + " NEAR" : "NOT CREATED"}`);
  }
} else if (cmd === "deploy") {
  if (!prefix) die("set NEAR_PREFIX (the same as for `accounts`)");
  const p = ids(prefix);
  for (const id of [p.contract, p.relay, ...p.members]) await loadKey(id);
  const wasm = readFileSync(new URL("../contract/fair_share.wasm", import.meta.url));
  const vendored = readFileSync(new URL("../vendor/sputnikdao2.wasm", import.meta.url));
  note(`# deploy ${new Date().toISOString()}  contract wasm ${wasmCodeHash(wasm)} (${wasm.length} bytes)  vendored sputnik wasm ${wasmCodeHash(vendored)}`);
  if ((await codeHash(RPC, p.contract)) !== wasmCodeHash(wasm)) {
    await record("deploy contract", p.contract, "deploy_contract", (await (await near.account(p.contract)).deployContract(wasm)) as unknown as Outcome);
    await call("contract new", p.contract, p.contract, "new", {});
  }
  const dao = `${p.daoName}.${FACTORY}`;
  const args = Buffer.from(JSON.stringify({ config: { name: p.daoName, purpose: "pays Fair Share splits", metadata: "" }, policy: daoPolicy(p.members, DAO_BOND) })).toString("base64");
  if (!(await accountState(dao))) await call("factory create DAO", p.relay, FACTORY, "create", { name: p.daoName, args }, DAO_DEPOSIT, 300n * 10n ** 12n);
  const d: Deployment = { network: "testnet", rpc: RPC, factory: FACTORY, contract: p.contract, dao, relay: p.relay, members: p.members, contractCodeHash: await codeHash(RPC, p.contract), daoCodeHash: await codeHash(RPC, dao), bond: ROUND_BOND.toString() };
  writeFileSync(DEPLOYMENT, JSON.stringify(d, null, 2) + "\n");
  note(`contract ${d.contract} code ${d.contractCodeHash}`);
  note(`dao ${d.dao} code ${d.daoCodeHash}  ${d.daoCodeHash === wasmCodeHash(vendored) ? "= vendored vendor/sputnikdao2.wasm" : "DIFFERS from vendor/sputnikdao2.wasm " + wasmCodeHash(vendored)}`);
} else if (cmd === "round") {
  const roundId = rest.find((a) => !a.startsWith("--")) ?? die("usage: npm run testnet -- round <id> [--silent]");
  const silent = rest.includes("--silent");
  const d = deployment();
  for (const id of [d.relay, ...d.members]) await loadKey(id);
  evidence = `${EVIDENCE}${roundId}.txt`;
  const resumed = existsSync(evidence); // a run that stopped half way (network, faucet...) continues where the chain says it stopped
  const truth = [40, 30, 20, 10];
  const rows = truth.map((_, k) => (!silent && k === 3 ? [90, 5, 5, 0] : truth.map((v, j) => (j === k ? 0 : v))));
  const salt = (m: string) => createHash("sha256").update(`${read(keyPath(m))}|${roundId}`).digest("hex").slice(0, 16);
  const who = silent ? d.members.slice(0, 3) : d.members; // the reveal set
  note(`# ${resumed ? "RESUMED " : ""}round ${roundId} on ${d.contract}, dao ${d.dao}, pot ${near2(POT)} NEAR, bond ${near2(ROUND_BOND)} NEAR, ${silent ? d.members[3] + " commits and never reveals" : d.members[3] + " rates the others 90 / 5 / 5 although the truth is 40 / 30 / 20 / 10"}`);

  type RoundNow = { status: string; commits: (string | null)[]; revealed: boolean[]; reveal_until_ms: string };
  const roundNow = () => view<RoundNow>(RPC, d.contract, "get_round", { round_id: roundId }).catch((e) => (String(e).includes("ERR_NO_SUCH_ROUND") ? null : Promise.reject(e)));
  const t0 = await nowMs();
  if (!(await roundNow())) {
    const commitUntil = t0 + 150_000, revealUntil = t0 + (silent ? 330_000 : 900_000);
    await call("create_round", d.relay, d.contract, "create_round", { round_id: roundId, dao: d.dao, pot: POT.toString(), bond: ROUND_BOND.toString(), members: d.members, commit_until_ms: String(commitUntil), reveal_until_ms: String(revealUntil) });
  }
  const members = d.members;
  const open = (await roundNow())!;
  await Promise.all(members.map((m, i) => open.commits[i] ? undefined : call(`commit ${NAMES[i]}`, m, d.contract, "commit", { round_id: roundId, commitment: commitHash(roundId, m, rows[i], salt(m)) }, ROUND_BOND)));
  await Promise.all(who.map((m, i) => open.revealed[i] || (open.status === "final") ? undefined : call(`reveal ${NAMES[i]}`, m, d.contract, "reveal", { round_id: roundId, ratings: rows[i], salt: salt(m) })));
  if (silent && (await roundNow())!.status !== "final") {
    const revealUntil = Number(open.reveal_until_ms);
    note(`# ${members[3]} stays silent; waiting for the reveal deadline (${new Date(revealUntil).toISOString()})`);
    await waitPast(revealUntil);
    await call("finalize (anyone)", d.relay, d.contract, "finalize", { round_id: roundId });
  }
  const split = await view<{ share_bits: string[]; amounts: string[]; hash: string } | null>(RPC, d.contract, "get_split", { round_id: roundId });
  if (!split) throw new Error("no split stored");
  const want = fairShare(rows.map((r, k) => (silent && k === 3 ? neutralRow(4, 3) : r)));
  if (JSON.stringify(split.share_bits) !== JSON.stringify(want.map(shareBits))) throw new Error("stored split differs from src/rule.ts");
  note(`# stored split (bit-identical to src/rule.ts): ${split.share_bits.map((b) => (bitsToShare(b) * 100).toFixed(4) + "%").join(" / ")}  amounts ${split.amounts.map((a) => near2(BigInt(a))).join(" / ")} NEAR  hash ${split.hash}`);
  if (JSON.stringify(split.amounts) !== JSON.stringify(toAmounts(want, POT).map(String))) throw new Error("stored amounts differ from src/payout.ts");

  // pay out through the DAO: the relay (not a member) adds one Transfer proposal per member, 3 of 4 council members vote
  const amounts = split.amounts.map(BigInt);
  const before = await Promise.all(members.map(balance));
  const daoBefore = await balance(d.dao);
  const spent = members.map(() => 0n);
  const proposals = await view<{ id: number; description: string; status: string }[]>(RPC, d.dao, "get_proposals", { from_index: 0, limit: 200 });
  for (let i = 0; i < 4; i++) {
    if (amounts[i] === 0n) continue;
    const kind = transferKind(members[i], amounts[i]);
    const description = proposalDescription(roundId, split.hash, members[i]);
    const id = proposals.find((p) => p.description === description)?.id ?? Number((await call(`dao add_proposal -> ${NAMES[i]}`, d.relay, d.dao, "add_proposal", { proposal: { description, kind } }, DAO_BOND)).value);
    for (let v = 0; v < 4; v++) {
      if ((await view<{ status: string }>(RPC, d.dao, "get_proposal", { id })).status !== "InProgress") break;
      spent[v] += (await call(`dao VoteApprove #${id} by ${NAMES[v]}`, members[v], d.dao, "act_proposal", { id, action: "VoteApprove", proposal: kind })).burnt;
    }
    const st = (await view<{ status: string }>(RPC, d.dao, "get_proposal", { id })).status;
    if (st !== "Approved") throw new Error(`proposal #${id} is ${st}`);
  }
  await new Promise((r) => setTimeout(r, 8000)); // let the last refund receipts land
  const after = await Promise.all(members.map(balance));
  const gained = after.map((a, i) => a - before[i] + spent[i]);
  note(`# balances (NEAR): before ${before.map(near2).join(" / ")}  after ${after.map(near2).join(" / ")}  vote gas paid ${spent.map(near2).join(" / ")}`);
  note(`# gained + vote gas = amount, to the yocto? ${gained.every((g, i) => g === amounts[i]) ? "yes, all four" : "NO " + gained.map((g, i) => g - amounts[i]).join(" / ") + " yocto off"}  DAO balance change ${near2((await balance(d.dao)) - daoBefore)} NEAR (pot out, bonds back)`);
  const { match, checks } = checkRound(await loadRound(RPC, d.contract, roundId));
  for (const c of checks) note(`# verify ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  note(`# verify ${match ? "MATCH" : "MISMATCH"} ${roundId}   (npm run verify -- ${roundId})`);
  if (!match || !gained.every((g, i) => g === amounts[i])) process.exit(1);
} else if (cmd === "links") {
  // The explorer page is behind a Cloudflare challenge for scripts (HTTP 403), so "opens" cannot be shown by a script. What can be shown:
  // nearblocks' own API (v3) has indexed the transaction and reports success, and the page answers (200, or 403 with the challenge).
  const out: string[] = [];
  for (const f of readdirSync(EVIDENCE).filter((f) => f.endsWith(".txt") && f !== "links.txt")) {
    const hashes = [...read(EVIDENCE + f).matchAll(/ \| ([1-9A-HJ-NP-Za-km-z]{43,44}) \| success \|/g)].map((m) => m[1]);
    let indexed = 0;
    const pages = new Map<number, number>();
    for (const h of hashes) {
      const page = await fetch(EXPLORER + h);
      pages.set(page.status, (pages.get(page.status) ?? 0) + 1);
      // the free nearblocks API answers 429 above a few requests per minute: go slowly and retry
      let api = await fetch(`https://api-testnet.nearblocks.io/v3/txns/${h}`);
      for (let t = 0; api.status === 429 && t < 6; t++) {
        await new Promise((r) => setTimeout(r, 10_000));
        api = await fetch(`https://api-testnet.nearblocks.io/v3/txns/${h}`);
      }
      await new Promise((r) => setTimeout(r, 1_500));
      const j = (await api.json().catch(() => null)) as { data?: { transaction_hash?: string; outcomes?: { status?: boolean } } } | null;
      if (j?.data?.transaction_hash === h && j.data.outcomes?.status === true) indexed++;
      else say(`${f} ${h}: nearblocks api ${api.status}, status ${JSON.stringify(j?.data?.outcomes?.status)}`);
    }
    out.push(`${f}: ${indexed} of ${hashes.length} transactions found by the nearblocks testnet API with status success; explorer page HTTP answers: ${[...pages].map(([k, v]) => `${v}x${k}`).join(" ")}`);
  }
  out.forEach((l) => say(l));
  writeFileSync(EVIDENCE + "links.txt", `# checked ${new Date().toISOString()} by \`npm run testnet -- links\`\n${out.join("\n")}\n`);
} else die("usage: npm run testnet -- accounts | deploy | round <id> [--silent] | links");
