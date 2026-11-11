// Read-only JSON-RPC view calls (no accounts, no signing): works against the sandbox node and, later, a testnet RPC.
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

/** Read one round from the Fair Share contract and the payout proposals from the round's DAO. */
export async function loadRound(rpc: string, contract: string, roundId: string): Promise<ChainData> {
  const round = await view<RoundView>(rpc, contract, "get_round", { round_id: roundId });
  const split = await view<SplitView | null>(rpc, contract, "get_split", { round_id: roundId });
  const reveals = split ? await view<RevealView[]>(rpc, contract, "get_reveals", { round_id: roundId }) : null;
  const last = await view<number>(rpc, round.dao, "get_last_proposal_id");
  const proposals: DaoProposal[] = [];
  for (let from = 0; from < last; from += 50) proposals.push(...(await view<DaoProposal[]>(rpc, round.dao, "get_proposals", { from_index: from, limit: 50 })));
  return { round, split, reveals, proposals };
}
