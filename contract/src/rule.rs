//! Rust port of ../../src/rule.ts and ../../src/payout.ts. Same f64 operations in the same order, so the results are
//! bit-identical to the TypeScript (checked on 9,000 profiles by tests/parity.rs). No near-sdk types in here.
//! Impartial division of a dollar: de Clippel, Moulin & Tideman (2008), Theorem 1, formulas (9)-(10), arithmetic means.

pub const MIN_MEMBERS: usize = 4;
pub const MAX_MEMBERS: usize = 12;
pub const MAX_RATING: u32 = 1_000_000;
/// Decimal grid for payouts: 10^-12 of the pot, so 40/30/20/10 on 10 NEAR is exactly 4/3/2/1 NEAR.
const GRID: f64 = 1e12;

/// ratings[k][j] = weight member k gives member j (integer 1..=MAX_RATING); ratings[k][k] must be 0.
pub fn fair_share(ratings: &[Vec<u32>]) -> Result<Vec<f64>, &'static str> {
    let n = ratings.len();
    if !(MIN_MEMBERS..=MAX_MEMBERS).contains(&n) {
        return Err("ERR_MEMBER_COUNT");
    }
    for (k, row) in ratings.iter().enumerate() {
        if row.len() != n {
            return Err("ERR_ROW_LENGTH");
        }
        for (j, &v) in row.iter().enumerate() {
            let ok = if j == k { v == 0 } else { (1..=MAX_RATING).contains(&v) };
            if !ok {
                return Err("ERR_RATING");
            }
        }
    }
    let x: Vec<Vec<f64>> = ratings
        .iter()
        .map(|row| {
            let sum = row.iter().fold(0.0_f64, |a, &v| a + v as f64);
            row.iter().map(|&v| v as f64 / sum).collect()
        })
        .collect();
    let r = |k: usize, j: usize, i: usize| x[k][j] / x[k][i]; // r^k_ji
    let (nf2, nf3) = ((n - 2) as f64, (n - 3) as f64);
    // f[i][j] = f_i^{-j}, formula (10)
    let mut f = vec![vec![0.0_f64; n]; n];
    for i in 0..n {
        for j in 0..n {
            if i == j {
                continue;
            }
            let (mut direct, mut indirect) = (0.0_f64, 0.0_f64);
            for k in 0..n {
                if k == i || k == j {
                    continue;
                }
                direct += r(k, j, i);
                let mut inner = 0.0_f64;
                for l in 0..n {
                    if l != i && l != j && l != k {
                        inner += r(l, k, i);
                    }
                }
                indirect += inner / nf3;
            }
            f[i][j] = 1.0 / (1.0 + direct / nf2 + indirect);
        }
    }
    // formula (9): share_i = (1/n) (1 + sum_{j != i} (f_i^{-j} - f_j^{-i}))
    Ok((0..n)
        .map(|i| {
            let mut s = 1.0_f64;
            for j in 0..n {
                if j != i {
                    s += f[i][j] - f[j][i];
                }
            }
            s / n as f64
        })
        .collect())
}

/// Integer amounts that sum EXACTLY to pot: weights on the decimal GRID, largest remainder, ties by member order.
pub fn to_amounts(shares: &[f64], pot: u128) -> Vec<u128> {
    let w: Vec<u128> = shares.iter().map(|s| (s * GRID + 0.5).floor() as u128).collect();
    let sum_w: u128 = w.iter().sum();
    // pot = q*sum_w + p keeps every product inside u128 (pot * w alone would overflow)
    let (q, p) = (pot / sum_w, pot % sum_w);
    let mut amounts: Vec<u128> = w.iter().map(|&wi| q * wi + p * wi / sum_w).collect();
    let rem: Vec<u128> = w.iter().map(|&wi| p * wi % sum_w).collect();
    let mut left = pot - amounts.iter().sum::<u128>();
    let mut order: Vec<usize> = (0..w.len()).collect();
    order.sort_by(|&a, &b| rem[b].cmp(&rem[a]).then(a.cmp(&b)));
    for i in order {
        if left == 0 {
            break;
        }
        amounts[i] += 1;
        left -= 1;
    }
    amounts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn truthful() -> Vec<Vec<u32>> {
        let t = [40u32, 30, 20, 10];
        (0..4).map(|k| (0..4).map(|j| if j == k { 0 } else { t[j] }).collect()).collect()
    }

    #[test]
    fn consensual_pays_exactly_4_3_2_1_near() {
        let s = fair_share(&truthful()).unwrap();
        let near = 10u128.pow(24);
        assert_eq!(to_amounts(&s, 10 * near), vec![4 * near, 3 * near, 2 * near, near]);
    }

    #[test]
    fn liar_d_keeps_ten_percent() {
        let mut r = truthful();
        r[3] = vec![90, 5, 5, 0];
        let s = fair_share(&r).unwrap();
        assert!((s[3] - 0.10).abs() < 1e-12, "{s:?}");
    }

    #[test]
    fn rejects_bad_input() {
        assert!(fair_share(&truthful()[..3]).is_err());
        let mut r = truthful();
        r[0][0] = 5;
        assert!(fair_share(&r).is_err());
        let mut r = truthful();
        r[1][2] = 0;
        assert!(fair_share(&r).is_err());
    }

    #[test]
    fn amounts_edge_cases() {
        assert_eq!(to_amounts(&[0.25; 4], 1), vec![1, 0, 0, 0]);
        assert_eq!(to_amounts(&[1.0 / 3.0; 3], 10), vec![4, 3, 3]);
    }
}
