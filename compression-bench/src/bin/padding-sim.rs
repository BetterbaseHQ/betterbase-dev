//! Padding-scheme simulation, PRIVACY-FIRST: how much size information does
//! each scheme leak, and what storage does that protection cost?
//!
//! Method modeled on the PURBs/Padmé evaluation (USENIX Security 2019), with
//! the objective inverted: privacy is the constraint, storage is the price.
//!
//! Leak metrics (primary):
//!   classes    — distinct observable blob sizes (observer resolution)
//!   k≥5/50/500 — fraction of records whose padded size is shared by at
//!                least k records (k-anonymity on size; an observer cannot
//!                distinguish records within a class)
//!   tail-anon  — median size-class occupancy among records ≥1MB (the
//!                sensitive embedded-doc tail: the smallest crowds the
//!                large records get to hide in)
//!
//! Cost metrics (secondary):
//!   stored/inflat — total stored bytes vs unpadded baseline
//!   unpush        — records the scheme cannot push (ladder overflow)
//!
//! Schemes:
//!   none         — exact lengths (what encryption alone gives you)
//!   current 4×   — DEFAULT_PADDING_BUCKETS, max 1MB (today's default)
//!   extended 4×  — 4× ladder extended to the 5MB server cap
//!   next-pow-2   — power-of-two ladder (paper strawman)
//!   padme        — Padmé: log-scale granularity, max +12% overhead,
//!                  leaks ~2× the bits of next-pow-2
//!   hybrid-16k   — 4× ladder ≤16K, Padmé above
//!   hybrid-256k  — 4× ladder ≤256K, Padmé above (strongest tail-adjacent
//!                  anonymity of the cheap options)
//!
//! Profiles (lognormal mixtures — standard file-size model):
//!   typical   — 72% small / 18% medium / 8% large / 2% huge (embedded docs)
//!   messenger — 95% small / 4.5% medium / 0.5% large, no huge records
//!
//! Run: cargo run --release --bin padding-sim

const CAP: usize = 5 * 1024 * 1024; // server per-blob limit
const ENC_OVERHEAD: usize = 13; // v4: version byte + IV + GCM tag
const N: usize = 100_000;

/// Deterministic xorshift64* (fixed seeds → reproducible).
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    fn next_f64(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        (x.wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        let u1 = self.next_f64().max(1e-12);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
    /// Lognormal sample with the given median, in bytes.
    fn lognormal(&mut self, median: usize, sigma: f64) -> usize {
        (median as f64 * (self.normal() * sigma).exp()).max(16.0) as usize
    }
}

// ── Padding schemes ──────────────────────────────────────────────────────────

const CURRENT: &[usize] = &[256, 1024, 4096, 16384, 65536, 262144, 1048576];
const EXTENDED4X: &[usize] = &[
    256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 5242888,
];

fn bucket(payload: usize, buckets: &[usize]) -> Option<usize> {
    buckets.iter().copied().find(|&b| payload + 4 <= b)
}

fn next_pow2_buckets() -> Vec<usize> {
    (8..=23).map(|e| 1 << e).collect() // 256B .. 8MB
}

/// Padmé (PURBs §4): round payload+prefix up so its low E−S bits are zero,
/// E = ⌊log₂ L⌋, S = bit-length of E. Max +12%, decreasing with size.
fn padme(payload: usize) -> usize {
    let l = (payload + 4).max(1);
    let e = (usize::BITS - 1 - l.leading_zeros()) as u32;
    let s = if e == 0 { 1 } else { 32 - e.leading_zeros() };
    let granularity = 1usize << (e - s);
    l.div_ceil(granularity) * granularity
}

#[derive(Clone, Copy)]
enum Scheme {
    None,
    Current,
    Extended4x,
    NextPow2,
    Padme,
    Hybrid16k,
    Hybrid256k,
}

impl Scheme {
    fn name(self) -> &'static str {
        match self {
            Scheme::None => "none (no padding)",
            Scheme::Current => "current 4x (1M)",
            Scheme::Extended4x => "extended 4x (5M)",
            Scheme::NextPow2 => "next-pow-2",
            Scheme::Padme => "padme",
            Scheme::Hybrid16k => "hybrid 4x<=16k+padme",
            Scheme::Hybrid256k => "hybrid 4x<=256k+padme",
        }
    }
    /// Padded blob size (payload padded + encryption overhead), or None if
    /// unpushable under this scheme (ladder overflow or over the cap).
    fn blob(self, payload: usize) -> Option<usize> {
        if payload + 4 > CAP {
            return None; // server rejects regardless of scheme
        }
        let padded = match self {
            Scheme::None => payload + 4,
            Scheme::Current => bucket(payload, CURRENT)?,
            Scheme::Extended4x => bucket(payload, EXTENDED4X)?,
            Scheme::NextPow2 => bucket(payload, &next_pow2_buckets())?,
            Scheme::Padme => padme(payload),
            Scheme::Hybrid16k => {
                if payload + 4 <= 16384 {
                    bucket(payload, CURRENT)?
                } else {
                    padme(payload)
                }
            }
            Scheme::Hybrid256k => {
                if payload + 4 <= 262144 {
                    bucket(payload, CURRENT)?
                } else {
                    padme(payload)
                }
            }
        };
        Some(padded + ENC_OVERHEAD)
    }
}

// ── Simulation ───────────────────────────────────────────────────────────────

type Parts = &'static [(f64, usize, f64)]; // (weight, median bytes, sigma)

const TYPICAL: Parts = &[
    (0.72, 1_200, 0.9),
    (0.18, 25_000, 1.0),
    (0.08, 250_000, 0.8),
    (0.02, 1_500_000, 0.6),
];

const MESSENGER: Parts = &[(0.95, 900, 0.8), (0.045, 12_000, 0.9), (0.005, 90_000, 0.7)];

fn sample(parts: Parts, rng: &mut Rng) -> Vec<usize> {
    let mut cum = Vec::with_capacity(parts.len());
    let mut acc = 0.0;
    for p in parts {
        acc += p.0;
        cum.push(acc);
    }
    (0..N)
        .map(|_| {
            let r = rng.next_f64();
            let idx = cum.iter().position(|&c| r <= c).unwrap_or(parts.len() - 1);
            let (_, median, sigma) = parts[idx];
            rng.lognormal(median, sigma)
        })
        .collect()
}

fn median(v: &mut [usize]) -> usize {
    v.sort_unstable();
    v[v.len() / 2]
}

fn run(name: &str, parts: Parts, seed: u64) {
    let mut rng = Rng::new(seed);
    let sizes = sample(parts, &mut rng);

    let raw_total: u64 = sizes.iter().map(|&s| s as u64 + 4 + ENC_OVERHEAD as u64).sum();
    let total_payload: f64 = sizes.iter().map(|&s| s as f64).sum();
    let tail_share = sizes
        .iter()
        .filter(|&&s| s >= 262_144)
        .map(|&s| s as f64)
        .sum::<f64>()
        / total_payload;

    println!("══ {name} ══");
    println!(
        "{N} records | raw ~{:.0} MB | ≥256K byte-share: {:.0}%",
        raw_total as f64 / 1e6,
        tail_share * 100.0
    );
    println!(
        "{:<22} {:>7} {:>6} {:>6} {:>6} {:>9} {:>9} {:>7} {:>6}",
        "scheme", "classes", "k≥5", "k≥50", "k≥500", "tail-anon", "stored MB", "inflat", "unpush"
    );

    for scheme in [
        Scheme::None,
        Scheme::Current,
        Scheme::Extended4x,
        Scheme::NextPow2,
        Scheme::Padme,
        Scheme::Hybrid16k,
        Scheme::Hybrid256k,
    ] {
        let mut stored: u64 = 0;
        let mut unpushable = 0;
        let mut raw_pushable: u64 = 0;
        let mut class_of: Vec<(usize, usize)> = Vec::with_capacity(N); // (blob size, is_tail)
        let mut occupancy: std::collections::HashMap<usize, usize> = Default::default();

        for &s in &sizes {
            match scheme.blob(s) {
                None => unpushable += 1,
                Some(blob) => {
                    stored += blob as u64;
                    raw_pushable += s as u64 + 4 + ENC_OVERHEAD as u64;
                    class_of.push((blob, usize::from(s >= 1_048_576)));
                    *occupancy.entry(blob).or_insert(0) += 1;
                }
            }
        }

        // k-anonymity: fraction of pushable records in classes of size ≥ k.
        let pushable = class_of.len();
        let k_frac = |k: usize| {
            class_of
                .iter()
                .filter(|(blob, _)| occupancy[blob] >= k)
                .count() as f64
                / pushable as f64
                * 100.0
        };
        // Tail anonymity: median occupancy of the classes that ≥1MB
        // records land in (how crowded the large-record hiding spots are).
        let mut tail_occ: Vec<usize> = class_of
            .iter()
            .filter(|(_, is_tail)| *is_tail == 1)
            .map(|(blob, _)| occupancy[blob])
            .collect();
        let tail_anon = if tail_occ.is_empty() {
            "—".to_string()
        } else {
            format!("{}", median(&mut tail_occ))
        };

        println!(
            "{:<22} {:>7} {:>5.0}% {:>5.0}% {:>5.0}% {:>9} {:>9.1} {:>6.0}% {:>6}",
            scheme.name(),
            occupancy.len(),
            k_frac(5),
            k_frac(50),
            k_frac(500),
            tail_anon,
            stored as f64 / 1e6,
            (stored as f64 / raw_pushable as f64 - 1.0) * 100.0,
            unpushable,
        );
    }
    println!();
}

fn main() {
    println!("Padding simulation (privacy-first) — {N} records/profile, 5MB cap\n");
    run("typical app (embedded docs in the tail)", TYPICAL, 0x51A1);
    run("messenger-style (no embedded docs)", MESSENGER, 0xBE5C);
    println!("Caveat: inflation is vs each scheme's own pushable raw bytes (schemes");
    println!("that cannot push some records count only what they store; see unpush).");
    println!("Anonymity sets are computed over the whole simulated population;");
    println!("per-app or per-user populations are smaller, so real k-anonymity is weaker.");
}
