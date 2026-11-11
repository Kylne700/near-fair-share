// Read-only JSON-RPC view calls (no accounts, no signing): works against the sandbox node and, later, a testnet RPC.
import { readFileSync } from "node:fs";
import { wasmCodeHash } from "./chain.ts";
import type { ChainData, DaoProposal, RevealView, RoundView, SplitView } from "./chain.ts";

export async function view<T>(rpc: string, accountId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "fair-share",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: accountId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  if (!body.result || body.result.error || !body.result.result) throw new Error(`view ${accountId}.${method} failed: ${JSON.stringify(body.error ?? body.result)}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
}

/** base58 sha256 of the contract code deployed on an account (what NEAR calls code_hash). */
export async function codeHash(rpc: string, accountId: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "fair-share", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
  });
  const body = (await res.json()) as { result?: { code_hash?: string }; error?: unknown };
  if (!body.result?.code_hash) throw new Error(`view_account ${accountId} failed: ${JSON.stringify(body.error ?? body.result)}`);
  return body.result.code_hash;
}

/** Read one round from the Fair Share contract and the payout proposals from the round's DAO. */
export async function loadRound(rpc: string, contract: string, roundId: string): Promise<ChainData> {
  const round = await view<RoundView>(rpc, contract, "get_round", { round_id: roundId });
  const split = await view<SplitView | null>(rpc, contract, "get_split", { round_id: roundId });
  const reveals = split ? await view<RevealView[]>(rpc, contract, "get_reveals", { round_id: roundId }) : null;
  const last = await view<number>(rpc, round.dao, "get_last_proposal_id");
  const proposals: DaoProposal[] = [];
  for (let from = 0; from < last; from += 50) proposals.push(...(await view<DaoProposal[]>(rpc, round.dao, "get_proposals", { from_index: from, limit: 50 })));
  return { round, split, reveals, proposals, daoCodeHash: await codeHash(rpc, round.dao), vendoredCodeHash: wasmCodeHash(readFileSync(new URL("../vendor/sputnikdao2.wasm", import.meta.url))) };
}
