// Impartial division of a dollar: de Clippel, Moulin & Tideman (2008), J. Econ. Theory 139:176-191,
// Theorem 1 with formulas (9)-(10) and arithmetic-mean aggregators (rho^{n-2} and rho^{n-3}).
// Notation: x^k_j = k's share of j among the others; r^k_ji = x^k_j / x^k_i (paper: r_ij = x_i / x_j).

/** reports[k][j] = weight member k gives member j. The diagonal reports[k][k] must be 0: nobody rates themselves. */
export type Reports = readonly (readonly number[])[];

export const MIN_MEMBERS = 4;

/** The row of a member who sent no valid reveal: everybody else equal, 0 for themselves (the contract's fallback). */
export const neutralRow = (n: number, k: number): number[] => Array.from({ length: n }, (_, j) => (j === k ? 0 : 1));

/**
 * Returns each member's share of the pot (sums to 1). Member i's share never reads row i,
 * so what i reports about the others cannot change i's own share (impartiality).
 * Rows are normalised to sum 1; only ratios between the OTHER members matter.
 */
export function fairShare(reports: Reports): number[] {
  const n = reports.length;
  if (n < MIN_MEMBERS) {
    // Prop. 1 of the paper: with 3 members no impartial, consensual rule can hand out the whole pot.
    throw new RangeError(`Fair Share needs at least ${MIN_MEMBERS} members, got ${n}`);
  }
  const x = reports.map((row, k) => {
    if (row.length !== n) throw new RangeError(`row ${k} has ${row.length} entries, expected ${n}`);
    if (row[k] !== 0) throw new RangeError(`row ${k}: the entry for yourself must be 0 (members rate only the others)`);
    let sum = 0;
    row.forEach((v, j) => {
      if (j !== k && !(Number.isFinite(v) && v > 0)) throw new RangeError(`row ${k}, member ${j}: report must be a positive finite number`);
      sum += v;
    });
    return row.map((v) => v / sum);
  });
  const r = (k: number, j: number, i: number) => x[k][j] / x[k][i]; // r^k_ji

  // f[i][j] = f_i^{-j}, formula (10): 1 / (1 + mean_k r^k_ji + sum_k mean_l r^l_ki), k outside {i,j}, l outside {i,j,k}
  const f = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let direct = 0;
      let indirect = 0;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        direct += r(k, j, i);
        let inner = 0;
        for (let l = 0; l < n; l++) if (l !== i && l !== j && l !== k) inner += r(l, k, i);
        indirect += inner / (n - 3);
      }
      f[i][j] = 1 / (1 + direct / (n - 2) + indirect);
    }
  }
  // formula (9): share_i = (1/n) (1 + sum_{j != i} (f_i^{-j} - f_j^{-i}))
  return f.map((fi, i) => {
    let s = 1;
    for (let j = 0; j < n; j++) if (j !== i) s += fi[j] - f[j][i];
    return s / n;
  });
}

/** Plain average of full claims (self included), the thing Fair Share replaces: claims[k][j] = k's claimed share of j. */
export function plainAverage(claims: Reports): number[] {
  const n = claims.length;
  const norm = claims.map((row) => {
    const s = row.reduce((a, b) => a + b, 0);
    return row.map((v) => v / s);
  });
  return Array.from({ length: n }, (_, j) => norm.reduce((a, row) => a + row[j], 0) / n);
}
