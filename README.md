# Fair Share

Split a pot between the people who earned it, so that lying about yourself cannot pay.

DRAFT: the rule, the payout rounding, the NEAR contract and a real round on NEAR testnet (free test tokens). The UI comes next.

## The problem

A team wins one prize and must split it. The usual way is to ask everyone for a split and average the answers. Then every member is tempted to claim more for themselves.

Example: pot $10,000, true split A 40 / B 30 / C 20 / D 10. A, B and C answer truthfully. D, whose true share is 10%, writes "100% me". The plain average gives D 32.5%, which is $3,250 instead of $1,000.

## What this does

Members rate only the OTHER members (positive shares, normalised to sum 1). The rule is the impartial division of de Clippel, Moulin and Tideman (2008), "Impartial division of a dollar", Journal of Economic Theory 139:176-191, Theorem 1, formulas (9) and (10) with arithmetic-mean aggregators. Properties, all tested here:

- Impartial: a member's own report never changes that member's own share (checked on 9,000 random teams, bit for bit).
- Consensual: if everybody's reports agree with one split, that split is paid exactly.
- Exact: the shares always sum to 1, none is negative.
- `src/payout.ts` turns the shares into integer amounts (bigint, for yoctoNEAR) that sum exactly to the pot (shares rounded to a 10^-12 grid, largest-remainder rounding, ties by member order; 40/30/20/10 of 10 NEAR is exactly 4/3/2/1 NEAR).

## Try it

1. Install: `npm ci` (needs Node 22.18 or newer; written and tested on Node 24, which runs the TypeScript files directly). `npm audit` then reports 15 findings (12 low, 2 high, 1 critical), all in the dev-only sandbox tools (`near-workspaces`, `near-sandbox` with an old `tar`, `near-api-js`); the project itself has no runtime dependencies.
2. Test: `npm test` (about 4 minutes: 15 rule, payout and demo tests, 13 tamper-detection tests, 7 tests against a local NEAR node). Expected end of the output: `tests 35`, `pass 35`, `fail 0`.
3. Demo: `npm run demo`. Expected (D keeps 10.0% under Fair Share, whatever D writes):

```
member    true   plain average        Fair Share
A        40.0%    30.0%  $3,000.00    58.8%  $5,884.03
B        30.0%    22.5%  $2,250.00    17.5%  $1,748.40
C        20.0%    15.0%  $1,500.00    13.7%  $1,367.57
D        10.0%    32.5%  $3,250.00    10.0%  $1,000.00
total             100%   $10,000.00          $10,000.00
```

(The demo also prints two header lines. In the plain average D claims 100% for herself; in Fair Share D rates the others A 90%, B 5%, C 5%.)

4. Type check: `npm run check`.

Use it from code: `fairShare(reports)` takes an n by n matrix where `reports[k][j]` is what member k gives member j and `reports[k][k]` is 0; `toAmounts(shares, pot)` gives the bigint amounts. Zero amounts are possible on tiny pots: skip those transfers.

## On NEAR

A spreadsheet or a form cannot stop a member from changing a rating after looking at the others, and nobody can check the result afterwards. Here the contract `contract/` (Rust, `fair_share`) does the part that needs trust:

1. The team creates a round: pot, bond, the member accounts, a commit deadline and a reveal deadline.
2. Each member COMMITS `sha256(round | account | ratings | salt)` and pays the round's bond. Nobody can open anything until all members have committed (or the commit deadline has passed).
3. Each member REVEALS ratings and salt. The contract recomputes the hash and refuses a reveal that does not match the commit (`ERR_REVEAL_MISMATCH`), a late one, or a self-rating. A valid reveal gets the bond back.
4. The contract computes the split with the same rule as `src/rule.ts` (same operations in the same order on doubles: the result is bit-identical, checked on 9,000 profiles) when the last member has revealed, or when anyone calls `finalize` after the reveal deadline. It stores exact yoctoNEAR amounts and a hash. Before that `get_split` returns null and `get_reveals` fails.
5. A member who does not reveal counts as having rated everybody else equally, and the bond goes to the DAO. Nobody's share reads their own row, so staying silent cannot change the silent member's own share; it only costs the bond. The last member to reveal can see all the others first, but refusing no longer kills the round and gains nothing.
6. Payment is not done by this contract. The team's own Sputnik DAO v2 (the official wasm in `vendor/`) gets one Transfer proposal per member (amount from the stored split, description `fair-share round=<id> split=<hash> payee=<account>`); members vote `VoteApprove` and the DAO pays. The multisig is not rebuilt.
7. `npm run verify -- <round>` reads the chain, recomputes everything and prints `MATCH` or `MISMATCH` for the commits, the split, the amounts, the hash, the DAO proposals and the DAO's code.

Try it (needs no account and no network; the first start downloads the NEAR sandbox binary):

- `npm run sandbox` plays a consensual 40/30/20/10 round with a 10 NEAR pot, a round where D lies, the refused cheats and a round where D stays silent after seeing the others, printing every transaction. `npm run sandbox -- --keep` leaves the node up so `npm run verify -- consensual` can be run in a second terminal.
- `npm test` also runs the sandbox tests. `npm run test:contract` runs the Rust tests and the 9,000-profile parity check (needs rustc 1.86). `npm run build:contract` rebuilds `contract/fair_share.wasm` (the committed file is what the tests use).
- `npm run testnet` runs a real round on NEAR testnet (see "Run it on testnet" below). `npm run verify -- <round>` checks any round on the chain it points at.

Honest limits of the on-chain part:

- Ratings are sealed only until the reveal. After the reveals they are public in the transaction arguments (the verify step needs them).
- Staying silent is protected per member, not against groups: a silent member's own share is unchanged, but their row is replaced by the neutral one, which moves the other members' shares just as a lie about them would. With several silent members, each of them still cannot change their own share by being silent.
- The contract holds no pot, only the bonds while a round runs. It pays storage for its rounds from its own balance (before a mainnet use it should take a deposit per round).
- Collusion is not prevented (see below).
- Float arithmetic runs on the real testnet runtime too: the split stored by the contract on testnet is bit-identical to `src/rule.ts` (`npm run verify` recomputes it). The DAO on testnet was created by the official factory `sputnikv2.testnet`, and its code hash equals `vendor/sputnikdao2.wasm`.
- The testnet run is a small demo (1 NEAR pot, 0.1 NEAR bond, 4 accounts of one operator). It shows the flow works on a real network, not that anyone relies on it.

## Run it on testnet

Testnet only: free test tokens, nothing of value. Needs `npm ci` first and Node 22.18 or newer.

1. Check the round recorded in this repo (no account, no key): `npm run verify -- d-lies`. Expected: seven `ok` lines (round is final, reveals match their commits, split recomputed bit for bit, amounts sum exactly to the pot, split hash, DAO proposals executed, DAO code hash equals `vendor/sputnikdao2.wasm`) and the last line `MATCH d-lies`. The same for the withholder round: `npm run verify -- withhold` (expected last line `MATCH withhold`).
2. Make six accounts and fund them from the testnet faucet: `NEAR_PREFIX=my-fs NEAR_KEYS_DIR=$HOME/.my-fs-keys npm run testnet -- accounts`. Keys are written with mode 600 into that folder and never printed. Expected: one line per account.
3. Deploy the contract and create the team DAO with the official Sputnik v2 testnet factory `sputnikv2.testnet`: `NEAR_PREFIX=my-fs NEAR_KEYS_DIR=$HOME/.my-fs-keys npm run testnet -- deploy`. Expected: `success` lines with explorer links. (This overwrites `evidence/testnet/deployment.json`: run it in a copy of the repo.)
4. Play a round (commit, reveal, split, DAO Transfer proposals, votes, payout, balances checked): `NEAR_KEYS_DIR=$HOME/.my-fs-keys npm run testnet -- round r1`, about 5 minutes. Add `--silent` to make the last member commit and never reveal. Expected: every transaction as `label | from -> call | hash | success | link`, written to `evidence/testnet/r1.txt`.
5. Verify it from the chain: `npm run verify -- r1`. Expected: last line `MATCH r1`.

### The recorded run

Everything below is on NEAR testnet (contract `fairshare-d3a-contract.testnet`, team DAO `fairshare-d3a-team.sputnikv2.testnet`, made by the official `sputnikv2.testnet` factory). All 53 recorded transactions end in `success` according to the nearblocks testnet API (`evidence/testnet/links.txt`). The explorer page itself is behind a Cloudflare check that scripts cannot pass, so that the pages open in a browser is NOT VERIFIED.

- Setup: [deploy contract](https://testnet.nearblocks.io/txns/6SaTxwwm8HcLjA3r2yWqPhrBKs9fpqePZu7VaCs6xRJt), [contract new](https://testnet.nearblocks.io/txns/DG1BaGCBHRKwfvhB7YjZMvPenVYApFhfobUEEGKkV69e), [factory create DAO](https://testnet.nearblocks.io/txns/6qgqJyKXdwrn2iHQay4ouKAv8uTQXfazZj8uwDddzLNL).
- Round `d-lies` (D writes 90/5/5 about the others and still gets 10.0000%; pot 1 NEAR paid as 0.588403 / 0.174840 / 0.136757 / 0.100000): [create_round](https://testnet.nearblocks.io/txns/CrxLcj9UVR3koE9fZEuxR15k6ZoQcEjhB7MZsBuLvm3N), [commit alice](https://testnet.nearblocks.io/txns/6vvDFUHu5gXX6Q7e5mjvtr3EKRAAApeASFbVdhBWoiB7), [reveal alice](https://testnet.nearblocks.io/txns/FDd2J32W6sRCThwo6y6985iagKmQntYhUpmswK3Qw2xe), [dao add_proposal -> dave](https://testnet.nearblocks.io/txns/7322vPxRKDSYjHiTNNr6mNM7wkbAo5gQadwXxdKVJJsB), [dao VoteApprove #3 by carol](https://testnet.nearblocks.io/txns/AYVRw2z5nxxpcsLMGksXyFGp7khBprFWBefgU6W56wRY).
- Round `withhold` (D commits, never reveals, loses the 0.1 NEAR bond to the DAO; the other three are paid 0.354405 / 0.303709 / 0.241886 and D 0.100000): [create_round](https://testnet.nearblocks.io/txns/253CkCYQkXzraGBMf5cYBaEecnQqAVtckFdmpJE2FELb), [commit dave](https://testnet.nearblocks.io/txns/246p8FAj9c2hEe5CpVrQAq4bEq4T3j45cw8Bp8k5an2x), [finalize (anyone)](https://testnet.nearblocks.io/txns/42c4NHFX5YGVEWFXj376D1rNiWpbzW3KzkoNpBXaYmaf), [dao add_proposal -> dave](https://testnet.nearblocks.io/txns/21WK8vemDJh8EuE98na3s4vcSN6EvHtCHVbxJdeDkcUQ), [dao VoteApprove #7 by carol](https://testnet.nearblocks.io/txns/ANhLuv9TyB996G2Pj1L1rkWSr9sxJQbuSp93KtLBGGMV).
- Every transaction of both rounds, with hash and link: `evidence/testnet/d-lies.txt`, `evidence/testnet/withhold.txt`, `evidence/testnet/setup.txt`. The accounts were created by the testnet faucet, whose transactions are not recorded.

## Known limits

- Needs 4 or more members. With 3 no impartial, consensual rule can hand out the whole pot (Proposition 1 of the paper); with 2 the reports carry no information. Fewer than 4 members is an error.
- A liar cannot raise her own share, but she can move the others' shares. In the demo D's lie takes B from 30% to 17.5% and C from 20% to 13.7% while A gains.
- Impartial is not collusion-proof. Two members can gift each other: if A and D each rate the other 90% (B and C 5%, B and C truthful), A goes from 40% to 58.8% (+$1,884), D from 10% to 21.5% (+$1,152), B falls from 30% to 10.7% and C from 20% to 9.0%. No mitigation yet.
- Members must be known and each rates all the others; there is no check that the ratings are honest, only that your own rating cannot pay you.
- Shares are doubles; the payout step rounds them to a 10^-12 grid and then to whole yoctoNEAR so the sum is exact.

## Built with

- TypeScript on Node (native type stripping, `node:test`); Rust with `near-sdk` for the contract; `near-workspaces` for the local sandbox
- `fast-check` (property tests), `typescript` and `@types/node` (type check only)
- The rule is from de Clippel, Moulin and Tideman (2008). The formulas were checked against the authors' working-paper PDF, not the typeset journal version.
- The code was written with AI help (Claude, in Claude Code), directed by Kylne700.

## License

MIT, copyright Kylne700. See `LICENSE`.
