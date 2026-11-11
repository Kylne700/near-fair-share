# Fair Share

Split a pot between the people who earned it, so that lying about yourself cannot pay.

DRAFT: the rule, the payout rounding and the NEAR contract (local sandbox only; the UI and the testnet run come next).

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
2. Test: `npm test` (about 3 minutes: 13 rule and payout tests, 10 tamper-detection tests, 7 tests against a local NEAR node). Expected end of the output: `tests 30`, `pass 30`, `fail 0`.
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

1. The team creates a round: pot, the member accounts, a commit deadline and a reveal deadline.
2. Each member COMMITS `sha256(round | account | ratings | salt)`. Nobody can open anything until all members have committed.
3. Each member REVEALS ratings and salt. The contract recomputes the hash and refuses a reveal that does not match the commit (`ERR_REVEAL_MISMATCH`), a late one, or a self-rating.
4. The last reveal makes the contract compute the split with the same rule as `src/rule.ts` (same operations in the same order on doubles: the result is bit-identical, checked on 9,000 profiles) and store it with exact yoctoNEAR amounts and a hash. Before that `get_split` returns null and `get_reveals` fails.
5. Payment is not done by this contract. The team's own Sputnik DAO v2 (the official wasm in `vendor/`) gets one Transfer proposal per member (amount from the stored split, description `fair-share round=<id> split=<hash> payee=<account>`); members vote `VoteApprove` and the DAO pays. The multisig is not rebuilt.
6. `npm run verify -- <round>` reads the chain, recomputes everything and prints `MATCH` or `MISMATCH` for the commits, the split, the amounts, the hash and the DAO proposals.

Try it (needs no account and no network; the first start downloads the NEAR sandbox binary):

- `npm run sandbox` plays a consensual 40/30/20/10 round with a 10 NEAR pot, a round where D lies, and the refused cheats, printing every transaction. `npm run sandbox -- --keep` leaves the node up so `npm run verify -- consensual` can be run in a second terminal.
- `npm test` also runs the sandbox tests. `npm run test:contract` runs the Rust tests and the 9,000-profile parity check (needs rustc 1.86). `npm run build:contract` rebuilds `contract/fair_share.wasm` (the committed file is what the tests use).
- `npm run testnet:deploy` is prepared but refuses to run without `NEAR_TESTNET_OK=1`; it has not been run.

Honest limits of the on-chain part:

- Ratings are sealed only until the reveal. After the reveals they are public in the transaction arguments (the verify step needs them).
- The last member to reveal sees all the other ratings first and can still refuse to reveal. Then the round is aborted at the deadline and no split exists; the team falls back to its own DAO vote. Nothing forces completion.
- The contract holds no pot. It pays storage for its rounds from its own balance (before a mainnet use it should take a deposit).
- Collusion is not prevented (see below). Float arithmetic was accepted by the sandbox runtime (nearcore 2.6.2); it still has to be re-checked on testnet.
- Only the local sandbox has been used. It is NOT VERIFIED that the Sputnik code the testnet factory deploys behaves like the vendored file.

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
