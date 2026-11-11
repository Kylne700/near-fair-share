// Everything the NEAR part needs that does not talk to a node: hashes, Sputnik DAO payloads, and the one function
// (checkRound) that decides MATCH or MISMATCH. The sandbox tests, `npm run verify` and the unit tests all use it.
import { createHash } from "node:crypto";
import { fairShare, neutralRow } from "./rule.ts";
import { toAmounts, YOCTO_PER_NEAR } from "./payout.ts";

export interface RoundView {
  round_id: string;
  creator: string;
  dao: string;
  pot: string;
  bond: string;
  members: string[];
  commit_until_ms: string;
  reveal_until_ms: string;
  status: "commit" | "reveal" | "expired" | "final";
  commits: (string | null)[];
  revealed: boolean[];
}
export interface SplitView {
  round_id: string;
  members: string[];
  pot: string;
  share_bits: string[];
  amounts: string[];
  hash: string;
}
export interface RevealView {
  member: string;
  commit: string | null;
  /** false: no valid reveal, ratings is the neutral row the split used */
  revealed: boolean;
  ratings: number[];
  salt: string;
}
export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
}
export interface ChainData {
  round: RoundView;
  split: SplitView | null;
  reveals: RevealView[] | null;
  proposals: DaoProposal[];
  /** base58 sha256 of the code on the DAO account, and of the vendored official wasm: both set => one more check */
  daoCodeHash?: string;
  vendoredCodeHash?: string;
}
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const dv = new DataView(new ArrayBuffer(8));
/** IEEE-754 bits of a double as 16 hex digits (what the contract stores; no float formatting involved). */
export const shareBits = (x: number) => (dv.setFloat64(0, x), dv.getBigUint64(0).toString(16).padStart(16, "0"));
export const bitsToShare = (hex: string) => (dv.setBigUint64(0, BigInt("0x" + hex)), dv.getFloat64(0));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** NEAR's code_hash notation: base58 of the sha256 bytes. */
export function base58(bytes: Uint8Array): string {
  let n = bytes.reduce((a, b) => (a << 8n) | BigInt(b), 0n);
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}
export const wasmCodeHash = (wasm: Uint8Array) => base58(createHash("sha256").update(wasm).digest());

/** What a member commits to: sha256 of this exact text (contract/src/lib.rs commit_hash). */
export const commitHash = (roundId: string, account: string, ratings: readonly number[], salt: string) =>
  sha256hex(`fair-share/v1|${roundId}|${account}|${ratings.join(",")}|${salt}`);

/** The hash the contract stores with the split (contract/src/lib.rs split_hash). */
export const splitHash = (roundId: string, pot: bigint, members: readonly string[], bits: readonly string[], amounts: readonly bigint[]) =>
  sha256hex(`fair-share/v1/split|${roundId}|${pot}|${members.join(",")}|${bits.join(",")}|${amounts.join(",")}`);

/** Sputnik DAO proposal text: round id + split hash + payee, so anyone can match a proposal to the stored split. */
export const proposalDescription = (roundId: string, hash: string, payee: string) => `fair-share round=${roundId} split=${hash} payee=${payee}`;
export const transferKind = (payee: string, amount: bigint) => ({ Transfer: { token_id: "", receiver_id: payee, amount: amount.toString() } });

/** Demo policy for the group's own DAO: anyone can propose, members vote, a majority (3 of 4) executes, bond 0.01 NEAR. */
export function daoPolicy(members: readonly string[], bond: bigint = YOCTO_PER_NEAR / 100n) {
  return {
    roles: [
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
      { name: "council", kind: { Group: [...members] }, permissions: ["*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: bond.toString(),
    proposal_period: "604800000000000",
    bounty_bond: bond.toString(),
    bounty_forgiveness_period: "86400000000000",
  };
}

// the DAO adds `"msg": null` to a Transfer, so compare the fields instead of the JSON text
function sameTransfer(a: unknown, payee: string, amount: bigint): boolean {
  const t = (a as { Transfer?: Record<string, unknown> } | null)?.Transfer;
  return !!t && t.token_id === "" && t.receiver_id === payee && t.amount === amount.toString() && (t.msg ?? null) === null;
}

/** Recompute everything from chain data and compare with what is stored. match = every check passes. */
export function checkRound(d: ChainData): { match: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const { round, split, reveals } = d;
  if (round.status !== "final" || !split || !reveals) {
    add("round is final", false, `status is "${round.status}": no split exists yet`);
    return { match: false, checks };
  }
  add("round is final", true, `${round.members.length} members, pot ${round.pot} yoctoNEAR`);
  const pot = BigInt(round.pot);
  const members = round.members;

  // a member without a valid reveal has the neutral row (and, if committed, lost the bond); everybody else must open their commit
  const badCommits = members.filter((m, i) => {
    const r = reveals[i];
    if (!r || r.member !== m || r.commit !== round.commits[i] || r.revealed !== round.revealed[i]) return true;
    if (!r.revealed) return r.ratings.join() !== neutralRow(members.length, i).join();
    return commitHash(round.round_id, m, r.ratings, r.salt) !== r.commit;
  });
  const forfeited = members.filter((_, i) => !round.revealed[i] && round.commits[i]);
  const silent = members.filter((_, i) => !round.revealed[i] && !round.commits[i]);
  const note = (forfeited.length ? `; bond forfeited by ${forfeited.join(", ")}` : "") + (silent.length ? `; never committed: ${silent.join(", ")}` : "");
  add("every reveal matches its commit (sha256 recomputed)", badCommits.length === 0, badCommits.length ? `bad: ${badCommits.join(", ")}` : `${round.revealed.filter(Boolean).length} of ${members.length}${note}`);

  let shares: number[] = [];
  try {
    shares = fairShare(reveals.map((r) => r.ratings));
    const bits = shares.map(shareBits);
    const same = bits.length === split.share_bits.length && bits.every((b, i) => b === split.share_bits[i]);
    add("split recomputed from the revealed ratings (bit for bit)", same, same ? shares.map((s) => (s * 100).toFixed(4) + "%").join(" / ") : `stored ${split.share_bits.join(",")} but recomputed ${bits.join(",")}`);
  } catch (e) {
    add("split recomputed from the revealed ratings (bit for bit)", false, String(e));
  }

  const amounts = split.amounts.map(BigInt);
  let expected: bigint[] = [];
  try {
    expected = toAmounts(shares, pot);
  } catch {
    /* reported by the check below */
  }
  const sum = amounts.reduce((a, b) => a + b, 0n);
  const amountsOk = expected.length === amounts.length && expected.every((a, i) => a === amounts[i]) && sum === pot;
  add("amounts recomputed and sum exactly to the pot", amountsOk, amountsOk ? amounts.map((a) => (Number(a / 10n ** 12n) / 1e12).toFixed(6) + " NEAR").join(" / ") : `stored ${amounts.join(",")} expected ${expected.join(",")}`);

  const hash = splitHash(round.round_id, pot, members, split.share_bits, amounts);
  add("split hash recomputed", hash === split.hash, hash === split.hash ? hash : `stored ${split.hash} recomputed ${hash}`);

  // DAO side
  const tag = `fair-share round=${round.round_id} `;
  const mine = d.proposals.filter((p) => p.description.startsWith(tag));
  const problems: string[] = [];
  let paid = 0;
  const used = new Set<number>();
  members.forEach((m, i) => {
    const want = proposalDescription(round.round_id, split.hash, m);
    const hits = mine.filter((p) => p.description === want);
    if (amounts[i] === 0n) {
      if (hits.length) problems.push(`${m} has amount 0 but proposal ${hits[0].id} exists`);
      return;
    }
    if (hits.length === 0) return problems.push(`no proposal for ${m}`);
    if (hits.length > 1) return problems.push(`${hits.length} proposals for ${m}`);
    const p = hits[0];
    used.add(p.id);
    if (!sameTransfer(p.kind, m, amounts[i])) problems.push(`proposal ${p.id} for ${m} does not pay ${amounts[i]}`);
    if (p.status === "Approved") paid++;
    else if (p.status !== "InProgress") problems.push(`proposal ${p.id} for ${m} is ${p.status}`);
  });
  mine.filter((p) => !used.has(p.id)).forEach((p) => problems.push(`unexpected proposal ${p.id}: ${p.description}`));
  const payees = amounts.filter((a) => a > 0n).length;
  if (mine.length === 0) add("DAO proposals match the stored split", true, "none created yet (split verified only)");
  else add("DAO proposals match the stored split", problems.length === 0, problems.length ? problems.join("; ") : `${payees} Transfer proposals, ${paid} executed (Approved)`);
  if (d.daoCodeHash !== undefined && d.vendoredCodeHash !== undefined) {
    add("the DAO runs the vendored official Sputnik v2 wasm (code hash)", d.daoCodeHash === d.vendoredCodeHash, d.daoCodeHash === d.vendoredCodeHash ? d.daoCodeHash : `DAO ${d.daoCodeHash} vendored ${d.vendoredCodeHash}`);
  }
  return { match: checks.every((c) => c.ok), checks };
}
