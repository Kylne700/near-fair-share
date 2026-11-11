//! Bit-for-bit parity with src/rule.ts and src/payout.ts on 9,000 seeded profiles.
//! Run through `npm run test:contract`, which writes the vectors first (VECTORS=<file>).
use fair_share::rule::{fair_share, to_amounts};
use near_sdk::serde_json::{self, Value};

#[test]
fn rust_equals_typescript_on_9000_profiles() {
    let path = std::env::var("VECTORS").expect("set VECTORS=<file from scripts/gen-vectors.ts> (npm run test:contract does)");
    let all: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(all.len(), 9000);
    let (mut max_n, mut small_pots) = (0, 0);
    for (c, p) in all.iter().enumerate() {
        let ratings: Vec<Vec<u32>> = p["ratings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row.as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect())
            .collect();
        let want_bits: Vec<u64> = p["shares"].as_array().unwrap().iter().map(|s| u64::from_str_radix(s.as_str().unwrap(), 16).unwrap()).collect();
        let shares = fair_share(&ratings).unwrap();
        let got_bits: Vec<u64> = shares.iter().map(|s| s.to_bits()).collect();
        assert_eq!(got_bits, want_bits, "profile {c}: shares differ");
        let pot: u128 = p["pot"].as_str().unwrap().parse().unwrap();
        let want: Vec<u128> = p["amounts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().parse().unwrap()).collect();
        assert_eq!(to_amounts(&shares, pot), want, "profile {c}: amounts differ");
        assert_eq!(want.iter().sum::<u128>(), pot);
        max_n = max_n.max(ratings.len());
        small_pots += (pot < 1_000_000_000) as u32;
    }
    println!("parity ok: 9000 profiles, n up to {max_n}, {small_pots} small pots");
}
