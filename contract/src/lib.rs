//! Fair Share on NEAR. One round = a pot, a paying DAO, a member list and two deadlines.
//! 1. COMMIT: each member stores sha256(round | account | ratings | salt) and can never change it.
//! 2. REVEAL: opens when every member has committed. The contract recomputes the hash and rejects a mismatch.
//! 3. The last reveal computes the split (same rule as src/rule.ts, bit for bit) and stores shares, exact amounts and a hash.
//! Ratings are sealed only while committing: revealed ratings are public in the transaction. What the contract guarantees
//! is that nobody can change a rating after seeing another one, and that no split exists before the last reveal.
//! The contract holds no money. The group's own Sputnik DAO pays the amounts.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

pub mod rule;

#[near(serializers = [borsh])]
struct Reveal {
    ratings: Vec<u32>,
    salt: String,
}

#[near(serializers = [borsh])]
struct Split {
    shares: Vec<f64>,
    amounts: Vec<u128>,
    hash: String,
}

#[near(serializers = [borsh])]
struct Round {
    creator: AccountId,
    dao: AccountId,
    pot: u128,
    members: Vec<AccountId>,
    commit_until_ms: u64,
    reveal_until_ms: u64,
    commits: Vec<Option<String>>,
    reveals: Vec<Option<Reveal>>,
    split: Option<Split>,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub round_id: String,
    pub creator: AccountId,
    pub dao: AccountId,
    pub pot: U128,
    pub members: Vec<AccountId>,
    pub commit_until_ms: U64,
    pub reveal_until_ms: U64,
    /// "commit" | "reveal" | "final" | "aborted" (a deadline passed before everyone was in)
    pub status: String,
    pub commits: Vec<Option<String>>,
    pub revealed: Vec<bool>,
}

#[near(serializers = [json])]
pub struct SplitView {
    pub round_id: String,
    pub members: Vec<AccountId>,
    pub pot: U128,
    /// IEEE-754 bits of each share as 16 hex digits (exact, no float formatting)
    pub share_bits: Vec<String>,
    pub amounts: Vec<U128>,
    pub hash: String,
}

#[near(serializers = [json])]
pub struct RevealView {
    pub member: AccountId,
    pub commit: String,
    pub ratings: Vec<u32>,
    pub salt: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    rounds: LookupMap<String, Round>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn csv<T: ToString>(v: &[T]) -> String {
    v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}

fn commit_hash(round_id: &str, who: &AccountId, ratings: &[u32], salt: &str) -> String {
    hex(&env::sha256(format!("fair-share/v1|{round_id}|{who}|{}|{salt}", csv(ratings)).as_bytes()))
}

fn split_hash(round_id: &str, pot: u128, members: &[AccountId], shares: &[f64], amounts: &[u128]) -> String {
    let bits: Vec<String> = shares.iter().map(|s| format!("{:016x}", s.to_bits())).collect();
    hex(&env::sha256(
        format!("fair-share/v1/split|{round_id}|{pot}|{}|{}|{}", csv(members), bits.join(","), csv(amounts)).as_bytes(),
    ))
}

fn status(r: &Round) -> &'static str {
    let now = env::block_timestamp_ms();
    if r.split.is_some() {
        "final"
    } else if r.commits.iter().all(Option::is_some) {
        if now > r.reveal_until_ms { "aborted" } else { "reveal" }
    } else if now > r.commit_until_ms {
        "aborted"
    } else {
        "commit"
    }
}

impl Contract {
    fn round(&self, id: &str) -> &Round {
        self.rounds.get(id).unwrap_or_else(|| env::panic_str("ERR_NO_SUCH_ROUND"))
    }
}

fn member_index(r: &Round) -> usize {
    let me = env::predecessor_account_id();
    r.members.iter().position(|m| *m == me).unwrap_or_else(|| env::panic_str("ERR_NOT_A_MEMBER"))
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self { rounds: LookupMap::new(b"r") }
    }

    /// Anyone may open a round. `dao` is the Sputnik DAO that will pay; `pot` (yoctoNEAR) is what it pays out.
    /// shortcut: storage is paid from the contract balance (fine for a funded testnet demo); charge a deposit before mainnet.
    pub fn create_round(
        &mut self,
        round_id: String,
        dao: AccountId,
        pot: U128,
        members: Vec<AccountId>,
        commit_until_ms: U64,
        reveal_until_ms: U64,
    ) {
        let id_ok = !round_id.is_empty()
            && round_id.len() <= 64
            && round_id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c));
        require!(id_ok, "ERR_BAD_ROUND_ID");
        require!(!self.rounds.contains_key(&round_id), "ERR_ROUND_EXISTS");
        let n = members.len();
        require!((rule::MIN_MEMBERS..=rule::MAX_MEMBERS).contains(&n), "ERR_MEMBER_COUNT");
        require!((1..n).all(|i| !members[..i].contains(&members[i])), "ERR_DUPLICATE_MEMBER");
        require!(pot.0 > 0, "ERR_ZERO_POT");
        let now = env::block_timestamp_ms();
        require!(now < commit_until_ms.0 && commit_until_ms.0 < reveal_until_ms.0, "ERR_BAD_DEADLINES");
        let round = Round {
            creator: env::predecessor_account_id(),
            dao,
            pot: pot.0,
            commits: vec![None; n],
            reveals: (0..n).map(|_| None).collect(),
            members,
            commit_until_ms: commit_until_ms.0,
            reveal_until_ms: reveal_until_ms.0,
            split: None,
        };
        env::log_str(&format!("fair-share create {round_id}"));
        self.rounds.insert(round_id, round);
    }

    /// Store the sealed rating: `commitment` = sha256("fair-share/v1|<round>|<you>|<r0,r1,..>|<salt>") as 64 hex digits.
    pub fn commit(&mut self, round_id: String, commitment: String) {
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("ERR_NO_SUCH_ROUND"));
        let i = member_index(r);
        require!(env::block_timestamp_ms() <= r.commit_until_ms, "ERR_COMMIT_CLOSED");
        require!(r.commits[i].is_none(), "ERR_ALREADY_COMMITTED");
        let hex_ok = commitment.len() == 64 && commitment.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
        require!(hex_ok, "ERR_BAD_COMMITMENT");
        r.commits[i] = Some(commitment);
    }

    /// Open the sealed rating. `ratings` has one integer 1..=1000000 per OTHER member and 0 for yourself, in member order.
    pub fn reveal(&mut self, round_id: String, ratings: Vec<u32>, salt: String) {
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("ERR_NO_SUCH_ROUND"));
        let i = member_index(r);
        require!(r.commits.iter().all(Option::is_some), "ERR_COMMIT_PHASE_OPEN");
        require!(env::block_timestamp_ms() <= r.reveal_until_ms, "ERR_REVEAL_CLOSED");
        require!(r.reveals[i].is_none(), "ERR_ALREADY_REVEALED");
        require!(salt.len() <= 64 && salt.chars().all(|c| c.is_ascii_alphanumeric()), "ERR_BAD_SALT");
        let n = r.members.len();
        let ratings_ok = ratings.len() == n
            && ratings.iter().enumerate().all(|(j, &v)| if j == i { v == 0 } else { (1..=rule::MAX_RATING).contains(&v) });
        require!(ratings_ok, "ERR_BAD_RATINGS");
        let want = r.commits[i].as_ref().unwrap();
        require!(commit_hash(&round_id, &r.members[i], &ratings, &salt) == *want, "ERR_REVEAL_MISMATCH");
        r.reveals[i] = Some(Reveal { ratings, salt });
        if r.reveals.iter().all(Option::is_some) {
            let rows: Vec<Vec<u32>> = r.reveals.iter().map(|v| v.as_ref().unwrap().ratings.clone()).collect();
            let shares = rule::fair_share(&rows).unwrap_or_else(|e| env::panic_str(e));
            let amounts = rule::to_amounts(&shares, r.pot);
            let hash = split_hash(&round_id, r.pot, &r.members, &shares, &amounts);
            env::log_str(&format!("fair-share final {round_id} {hash}"));
            r.split = Some(Split { shares, amounts, hash });
        }
    }

    pub fn get_round(&self, round_id: String) -> RoundView {
        let r = self.round(&round_id);
        RoundView {
            round_id,
            creator: r.creator.clone(),
            dao: r.dao.clone(),
            pot: U128(r.pot),
            members: r.members.clone(),
            commit_until_ms: U64(r.commit_until_ms),
            reveal_until_ms: U64(r.reveal_until_ms),
            status: status(r).to_string(),
            commits: r.commits.clone(),
            revealed: r.reveals.iter().map(Option::is_some).collect(),
        }
    }

    /// None until the last member has revealed: before that no split exists to read.
    pub fn get_split(&self, round_id: String) -> Option<SplitView> {
        let r = self.round(&round_id);
        r.split.as_ref().map(|s| SplitView {
            round_id,
            members: r.members.clone(),
            pot: U128(r.pot),
            share_bits: s.shares.iter().map(|x| format!("{:016x}", x.to_bits())).collect(),
            amounts: s.amounts.iter().map(|&a| U128(a)).collect(),
            hash: s.hash.clone(),
        })
    }

    /// The opened ratings, so anyone can recompute the split. Only once the round is final.
    pub fn get_reveals(&self, round_id: String) -> Vec<RevealView> {
        let r = self.round(&round_id);
        require!(r.split.is_some(), "ERR_NOT_FINAL");
        (0..r.members.len())
            .map(|i| {
                let v = r.reveals[i].as_ref().unwrap();
                RevealView {
                    member: r.members[i].clone(),
                    commit: r.commits[i].clone().unwrap(),
                    ratings: v.ratings.clone(),
                    salt: v.salt.clone(),
                }
            })
            .collect()
    }
}
