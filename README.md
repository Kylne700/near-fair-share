# Fair Share

Split a pot between the people who earned it, so that lying about yourself cannot pay.

DRAFT (D1): the rule and the payout rounding. The NEAR part (Sputnik DAO Transfer proposals) is added next.

## The problem

A team wins one prize and must split it. The usual way is to ask everyone for a split and average the answers. Then every member is tempted to claim more for themselves.

Example: pot $10,000, true split A 40 / B 30 / C 20 / D 10. A, B and C answer truthfully. D, whose true share is 10%, writes "100% me". The plain average gives D 32.5%, which is $3,250 instead of $1,000.

## What this does

Members rate only the OTHER members (positive shares, normalised to sum 1). The rule is the impartial division of de Clippel, Moulin and Tideman (2008), "Impartial division of a dollar", Journal of Economic Theory 139:176-191, Theorem 1, formulas (9) and (10) with arithmetic-mean aggregators. Properties, all tested here:

- Impartial: a member's own report never changes that member's own share (checked on 9,000 random teams, bit for bit).
- Consensual: if everybody's reports agree with one split, that split is paid exactly.
- Exact: the shares always sum to 1, none is negative.
- `src/payout.ts` turns the shares into integer amounts (bigint, for yoctoNEAR) that sum exactly to the pot (largest-remainder rounding, ties by member order).

## Try it

1. Install: `npm ci` (needs Node 22.18 or newer; written and tested on Node 24, which runs the TypeScript files directly). See: it ends with `found 0 vulnerabilities`.
2. Test: `npm test`. Expected end of the output: `tests 13`, `pass 13`, `fail 0`.
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

## Known limits

- Needs 4 or more members. With 3 no impartial, consensual rule can hand out the whole pot (Proposition 1 of the paper); with 2 the reports carry no information. Fewer than 4 members is an error.
- A liar cannot raise her own share, but she can move the others' shares. In the demo D's lie takes B from 30% to 17.5% and C from 20% to 13.7% while A gains.
- Impartial is not collusion-proof. Two members can gift each other: if A and D each rate the other 90% (B and C 5%, B and C truthful), A goes from 40% to 58.8% (+$1,884), D from 10% to 21.5% (+$1,152), B falls from 30% to 10.7% and C from 20% to 9.0%. No mitigation yet.
- Members must be known and each rates all the others; there is no check that the ratings are honest, only that your own rating cannot pay you.
- Shares are doubles; the payout step converts them with 53-bit precision and rounds so the sum is exact.

## Built with

- TypeScript on Node (native type stripping, `node:test`)
- `fast-check` (property tests), `typescript` and `@types/node` (type check only)
- The rule is from de Clippel, Moulin and Tideman (2008). The formulas were checked against the authors' working-paper PDF, not the typeset journal version.
- The code was written with AI help (Claude, in Claude Code), directed by Kylne700.

## License

MIT, copyright Kylne700. See `LICENSE`.
