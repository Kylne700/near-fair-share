//! Fair Share on NEAR. One round = a pot, a paying DAO, a member list and two deadlines.
//! 1. COMMIT: each member stores sha256(round | account | ratings | salt) and pays the round's bond. The commitment never changes.
//! 2. REVEAL: opens when every member has committed (or the commit deadline has passed). The contract recomputes the hash,
//!    rejects a mismatch, and gives the bond back on a valid reveal.
//! 3. The last reveal (or `finalize`, which anyone may call after the reveal deadline) computes the split (same rule as
//!    src/rule.ts, bit for bit) and stores shares, exact amounts and a hash.
//! A member without a valid reveal gets the neutral row "everybody else equal" and, if they had committed, loses the bond
//! to the DAO. Nobody's share reads their own row, so withholding never changes the withholder's own share: it only costs.
//! Ratings are sealed only while committing: revealed ratings are public in the transaction. What the contract guarantees
//! is that nobody can change a rating after seeing another one, that nobody can stop the round by staying silent, and that
//! no split exists before the last reveal. The contract only holds the bonds. The group's own Sputnik DAO pays the amounts.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

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
    bond: u128,
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
    /// yoctoNEAR each member pays at commit; refunded on a valid reveal, otherwise sent to the DAO
    pub bond: U128,
    pub members: Vec<AccountId>,
    pub commit_until_ms: U64,
    pub reveal_until_ms: U64,
    /// "commit" | "reveal" | "expired" (reveal deadline passed, anyone can `finalize`) | "final"
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
    pub commit: Option<String>,
    /// false: no valid reveal, `ratings` is the neutral row the split used and `salt` is empty
    pub revealed: bool,
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

fn reveal_open(r: &Round) -> bool {
    r.commits.iter().all(Option::is_some) || env::block_timestamp_ms() > r.commit_until_ms
}

fn status(r: &Round) -> &'static str {
    if r.split.is_some() {
        "final"
    } else if env::block_timestamp_ms() > r.reveal_until_ms {
        "expired"
    } else if reveal_open(r) {
        "reveal"
    } else {
        "commit"
    }
}

/// The row the split uses for member i: the revealed ratings, or "everybody else equal" (1 each, 0 for yourself).
fn row_of(r: &Round, i: usize) -> Vec<u32> {
    match &r.reveals[i] {
        Some(v) => v.ratings.clone(),
        None => (0..r.members.len()).map(|j| (j != i) as u32).collect(),
    }
}

/// A plain transfer via the two host calls it needs. `near_sdk::Promise` would link every promise action, including ones
/// (global contracts) that an older NEAR sandbox node does not know, so the wasm would not even load there.
fn pay(to: &AccountId, yocto: u128) {
    env::promise_batch_action_transfer(env::promise_batch_create(to), NearToken::from_yoctonear(yocto));
}

/// Store the split. Members that committed but never revealed lose their bond to the DAO.
fn close(round_id: &str, r: &mut Round) {
    let rows: Vec<Vec<u32>> = (0..r.members.len()).map(|i| row_of(r, i)).collect();
    let shares = rule::fair_share(&rows).unwrap_or_else(|e| env::panic_str(e));
    let amounts = rule::to_amounts(&shares, r.pot);
    let hash = split_hash(round_id, r.pot, &r.members, &shares, &amounts);
    let withheld = r.commits.iter().zip(&r.reveals).filter(|(c, v)| c.is_some() && v.is_none()).count() as u128;
    if withheld > 0 {
        pay(&r.dao, withheld * r.bond);
    }
    env::log_str(&format!("fair-share final {round_id} {hash} withheld={withheld}"));
    r.split = Some(Split { shares, amounts, hash });
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
        bond: U128,
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
        require!(bond.0 > 0, "ERR_ZERO_BOND");
        let now = env::block_timestamp_ms();
        require!(now < commit_until_ms.0 && commit_until_ms.0 < reveal_until_ms.0, "ERR_BAD_DEADLINES");
        let round = Round {
            creator: env::predecessor_account_id(),
            dao,
            pot: pot.0,
            bond: bond.0,
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
    /// Attach exactly the round's bond: it comes back with a valid reveal, and goes to the DAO if you do not reveal.
    #[payable]
    pub fn commit(&mut self, round_id: String, commitment: String) {
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("ERR_NO_SUCH_ROUND"));
        let i = member_index(r);
        require!(env::block_timestamp_ms() <= r.commit_until_ms, "ERR_COMMIT_CLOSED");
        require!(r.commits[i].is_none(), "ERR_ALREADY_COMMITTED");
        require!(env::attached_deposit() == NearToken::from_yoctonear(r.bond), "ERR_BOND");
        let hex_ok = commitment.len() == 64 && commitment.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
        require!(hex_ok, "ERR_BAD_COMMITMENT");
        r.commits[i] = Some(commitment);
    }

    /// Open the sealed rating. `ratings` has one integer 1..=1000000 per OTHER member and 0 for yourself, in member order.
    pub fn reveal(&mut self, round_id: String, ratings: Vec<u32>, salt: String) {
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("ERR_NO_SUCH_ROUND"));
        let i = member_index(r);
        require!(reveal_open(r), "ERR_COMMIT_PHASE_OPEN");
        require!(env::block_timestamp_ms() <= r.reveal_until_ms, "ERR_REVEAL_CLOSED");
        require!(r.commits[i].is_some(), "ERR_NOT_COMMITTED");
        require!(r.reveals[i].is_none(), "ERR_ALREADY_REVEALED");
        require!(salt.len() <= 64 && salt.chars().all(|c| c.is_ascii_alphanumeric()), "ERR_BAD_SALT");
        let n = r.members.len();
        let ratings_ok = ratings.len() == n
            && ratings.iter().enumerate().all(|(j, &v)| if j == i { v == 0 } else { (1..=rule::MAX_RATING).contains(&v) });
        require!(ratings_ok, "ERR_BAD_RATINGS");
        let want = r.commits[i].as_ref().unwrap();
        require!(commit_hash(&round_id, &r.members[i], &ratings, &salt) == *want, "ERR_REVEAL_MISMATCH");
        r.reveals[i] = Some(Reveal { ratings, salt });
        pay(&env::predecessor_account_id(), r.bond);
        if r.reveals.iter().all(Option::is_some) {
            close(&round_id, r);
        }
    }

    /// After the reveal deadline anyone may close the round: members without a valid reveal get the neutral row
    /// ("everybody else equal"), and the ones who had committed lose their bond to the DAO.
    pub fn finalize(&mut self, round_id: String) {
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("ERR_NO_SUCH_ROUND"));
        require!(r.split.is_none(), "ERR_ALREADY_FINAL");
        require!(env::block_timestamp_ms() > r.reveal_until_ms, "ERR_REVEAL_OPEN");
        close(&round_id, r);
    }

    pub fn get_round(&self, round_id: String) -> RoundView {
        let r = self.round(&round_id);
        RoundView {
            round_id,
            creator: r.creator.clone(),
            dao: r.dao.clone(),
            pot: U128(r.pot),
            bond: U128(r.bond),
            members: r.members.clone(),
            commit_until_ms: U64(r.commit_until_ms),
            reveal_until_ms: U64(r.reveal_until_ms),
            status: status(r).to_string(),
            commits: r.commits.clone(),
            revealed: r.reveals.iter().map(Option::is_some).collect(),
        }
    }

    /// None until the round is final (the last reveal, or `finalize`): before that no split exists to read.
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

    /// The rows the split used (opened ratings, or the neutral row), so anyone can recompute it. Only once the round is final.
    pub fn get_reveals(&self, round_id: String) -> Vec<RevealView> {
        let r = self.round(&round_id);
        require!(r.split.is_some(), "ERR_NOT_FINAL");
        (0..r.members.len())
            .map(|i| RevealView {
                member: r.members[i].clone(),
                commit: r.commits[i].clone(),
                revealed: r.reveals[i].is_some(),
                ratings: row_of(r, i),
                salt: r.reveals[i].as_ref().map(|v| v.salt.clone()).unwrap_or_default(),
            })
            .collect()
    }
}
