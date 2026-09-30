//! Padding-scheme simulation, PRIVACY-FIRST: how much size information does
//! each scheme leak, and what storage does that protection cost?
//!
//! Method modeled on the PURBs/Padmé evaluation (USENIX Security 2019), with
//! the objective inverted: privacy is the constraint, storage is the price.
//!
//! Leak metrics (primary):
//!   classes   — distinct observable blob sizes (observer resolution)
//!   k≥500     — fraction of records whose padded size is shared by at
//!               least 500 records (k-anonymity on size; an observer
//!               cannot distinguish records within a class)
//!   t-min/p10/med — per-record size-class occupancy among ≥1MB records
//!               (the sensitive embedded-doc tail), reported as min /
//!               p10 / median: the worst-off classes matter more than
//!               the median when the sensitive records are rare
//!
//! Cost metrics (secondary):
//!   inflat/p95 — mean / p95 per-record overhead vs raw (padded+13 bytes
//!               over payload+4+13), vs each scheme's own pushable bytes
//!   unpush     — records whose blob exceeds the 5MB server check
//!   ws-strand  — blobs legal per the 5MB check but over the 4 MiB WS
//!               message cap (pushable only after WS_MAX_MESSAGE_SIZE
//!               is raised)
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

const CAP: usize = 5 * 1024 * 1024; // server per-BLOB limit (verified: checks
                                    //                                     stored ciphertext = padded + 13 bytes)
const WS_CAP: usize = 4 * 1024 * 1024; // WS max message size (today; a ladder
                                       //                                        raise beyond 2 MiB requires raising it)
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
// Top bucket = CAP − ENC_OVERHEAD = 5MB − 13 (buckets already include
// the 4-byte length prefix: payload+4 ≤ b): the server validates the
// stored blob, so this bucket's blob is exactly CAP.
const TOP_BUCKET: usize = 5_242_867;
const EXTENDED4X: &[usize] = &[
    256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, TOP_BUCKET,
];

/// Pow-2 ladder ending at the blob-safe top bucket. NOTE: the 4 MiB bucket
/// produces blobs of 4,194,317 bytes — 13 over today's 4 MiB WS message cap —
/// so until WS_MAX_MESSAGE_SIZE is raised, records landing there are stranded
/// (reported in the ws-strand column, not unpush).
const POW2: &[usize] = &[
    256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
    2097152, 4194304, TOP_BUCKET,
];

/// Hybrid: pow-2 up to 1MB, then 4×-style jumps over the tail (no 2MB
/// bucket) — extra coarseness spent only where records are rare/sensitive.
const POW2_POW4_TAIL_1M: &[usize] = &[
    256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
    4194304, TOP_BUCKET,
];

/// Same idea, coarsening starting at 2MB instead (merges the 4M and top
/// classes — maximizes the worst-case tail crowd).
const POW2_POW4_TAIL_2M: &[usize] = &[
    256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
    2097152, TOP_BUCKET,
];

fn bucket(payload: usize, buckets: &[usize]) -> Option<usize> {
    buckets.iter().copied().find(|&b| payload + 4 <= b)
}

/// Padmé (PURBs §4): round payload+prefix up so its low E−S bits are zero,
/// E = ⌊log₂ L⌋, S = bit-length of E. Max +12%, decreasing with size.
fn padme(payload: usize) -> usize {
    let l = (payload + 4).max(1);
    // L >= 4 in practice (min payload 16B in the sim); guard the exponent
    // math anyway — e == 0 would underflow e - s in release builds.
    if l < 4 {
        return l;
    }
    let e = (usize::BITS - 1 - l.leading_zeros()) as u32;
    let s = 32 - e.leading_zeros();
    let granularity = 1usize << (e - s);
    l.div_ceil(granularity) * granularity
}

#[derive(Clone, Copy)]
enum Scheme {
    None,
    Current,
    Extended4x,
    NextPow2,
    Pow2Pow4Tail1M,
    Pow2Pow4Tail2M,
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
            Scheme::NextPow2 => "pow2 (to 5M cap)",
            Scheme::Pow2Pow4Tail1M => "pow2 + 4x tail @1M",
            Scheme::Pow2Pow4Tail2M => "pow2 + 4x tail @2M",
            Scheme::Padme => "padme",
            Scheme::Hybrid16k => "hybrid 4x<=16k+padme",
            Scheme::Hybrid256k => "hybrid 4x<=256k+padme",
        }
    }
    /// Padded blob size (padded payload + encryption overhead), or None if
    /// the blob exceeds the server's 5MB stored-blob validation.
    fn blob(self, payload: usize) -> Option<usize> {
        let padded = match self {
            Scheme::None => payload + 4,
            Scheme::Current => bucket(payload, CURRENT)?,
            Scheme::Extended4x => bucket(payload, EXTENDED4X)?,
            Scheme::NextPow2 => bucket(payload, POW2)?,
            Scheme::Pow2Pow4Tail1M => bucket(payload, POW2_POW4_TAIL_1M)?,
            Scheme::Pow2Pow4Tail2M => bucket(payload, POW2_POW4_TAIL_2M)?,
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
        let blob = padded + ENC_OVERHEAD;
        if blob > CAP {
            return None; // server checks the stored blob (verified)
        }
        Some(blob)
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

fn run(name: &str, parts: Parts, seed: u64) {
    let mut rng = Rng::new(seed);
    let sizes = sample(parts, &mut rng);

    let raw_total: u64 = sizes
        .iter()
        .map(|&s| s as u64 + 4 + ENC_OVERHEAD as u64)
        .sum();
    let total_payload: f64 = sizes.iter().map(|&s| s as f64).sum();
    let tail_share = sizes
        .iter()
        .filter(|&&s| s >= 262_144)
        .map(|&s| s as f64)
        .sum::<f64>()
        / total_payload;

    println!("══ {name} ══ (seed {seed:#x})");
    println!(
        "{N} records | raw ~{:.0} MB | ≥256K byte-share: {:.0}%",
        raw_total as f64 / 1e6,
        tail_share * 100.0
    );
    println!(
        "{:<22} {:>7} {:>6} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>8}",
        "scheme",
        "classes",
        "k≥500",
        "t-min",
        "t-p10",
        "t-med",
        "inflat",
        "p95",
        "unpush",
        "ws-strand"
    );

    for scheme in [
        Scheme::None,
        Scheme::Current,
        Scheme::Extended4x,
        Scheme::NextPow2,
        Scheme::Pow2Pow4Tail1M,
        Scheme::Pow2Pow4Tail2M,
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

        // k-anonymity at the standard threshold (k >= 500).
        let pushable = class_of.len();
        let k500 = class_of
            .iter()
            .filter(|(blob, _)| occupancy[blob] >= 500)
            .count() as f64
            / pushable as f64
            * 100.0;

        // Tail occupancy per record (min / p10 / median): the worst-off
        // classes matter more than the median when records are rare.
        let mut tail_occ: Vec<usize> = class_of
            .iter()
            .filter(|(_, is_tail)| *is_tail == 1)
            .map(|(blob, _)| occupancy[blob])
            .collect();
        tail_occ.sort_unstable();
        let tstat = |p: f64| -> String {
            if tail_occ.is_empty() {
                "—".to_string()
            } else {
                let i = ((tail_occ.len() - 1) as f64 * p) as usize;
                format!("{}", tail_occ[i.min(tail_occ.len() - 1)])
            }
        };

        // Per-record overhead p95 (the mean hides near-boundary worst cases).
        let mut overheads: Vec<f64> = Vec::with_capacity(pushable);
        for &s in &sizes {
            if let Some(blob) = scheme.blob(s) {
                let raw = s as f64 + 4.0 + ENC_OVERHEAD as f64;
                overheads.push(blob as f64 / raw - 1.0);
            }
        }
        overheads.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = if overheads.is_empty() {
            f64::NAN
        } else {
            overheads[((overheads.len() - 1) as f64 * 0.95) as usize] * 100.0
        };

        // Blobs legal per the 5MB server check but over today's 4 MiB WS
        // message cap — stranded until WS_MAX_MESSAGE_SIZE is raised.
        let ws_strand = class_of.iter().filter(|(blob, _)| *blob > WS_CAP).count();

        // Detail: occupancy of every class that ≥1MB records land in
        // (bytes, not KB — distinct blobs must not print identically).
        let tail_blobs: std::collections::HashSet<usize> = class_of
            .iter()
            .filter(|(_, is_tail)| *is_tail == 1)
            .map(|(blob, _)| *blob)
            .collect();
        let mut tail_classes: Vec<(usize, usize)> = occupancy
            .iter()
            .filter(|(blob, _)| tail_blobs.contains(blob))
            .map(|(blob, occ)| (*blob, *occ))
            .collect();
        tail_classes.sort();
        let detail = if tail_classes.len() > 10 {
            // Truncate pathological cases (e.g. 'none': thousands of singletons)
            let head = tail_classes
                .iter()
                .take(8)
                .map(|(blob, occ)| format!("{}:{}", blob, occ))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{head} … ({} classes)", tail_classes.len())
        } else {
            tail_classes
                .iter()
                .map(|(blob, occ)| format!("{}:{}", blob, occ))
                .collect::<Vec<_>>()
                .join(" ")
        };

        if unpushable == N {
            println!("{:<22} all records unpushable", scheme.name());
            continue;
        }

        println!(
            "{:<22} {:>7} {:>6} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>8}",
            scheme.name(),
            occupancy.len(),
            format!("{k500:.0}%"),
            tstat(0.0),
            tstat(0.1),
            tstat(0.5),
            format!(
                "{:.0}%",
                (stored as f64 / raw_pushable as f64 - 1.0) * 100.0
            ),
            format!("{p95:.0}%"),
            unpushable,
            ws_strand,
        );
        if !tail_classes.is_empty() {
            println!("{:>22} ≥1M classes (bytes:count): {detail}", "");
        }
    }
    println!();
}

fn main() {
    let seed_override = match std::env::var("SEED") {
        Err(_) => None,
        Ok(s) => {
            // Hex, with optional 0x/0X prefix (note: "123" parses as 0x123).
            let stripped = s.trim_start_matches("0x").trim_start_matches("0X");
            match u64::from_str_radix(stripped, 16) {
                Ok(v) => Some(v),
                Err(_) => {
                    eprintln!("warning: SEED={s:?} is not valid hex — using default seeds");
                    None
                }
            }
        }
    };
    let base = seed_override.unwrap_or(0);
    println!("Padding simulation (privacy-first) — {N} records/profile");
    println!("Blob cap 5MB (server checks stored blob) | WS cap 4 MiB (raise is a precondition)\n");
    run(
        "typical app (embedded docs in the tail)",
        TYPICAL,
        0x51A1 ^ base,
    );
    run(
        "messenger-style (no embedded docs)",
        MESSENGER,
        0xBE5C ^ base,
    );
    println!("Legend: t-min/p10/med = min/p10/median per-record class occupancy");
    println!("among ≥1MB records; p95 = per-record overhead p95; ws-strand =");
    println!("blobs legal per the 5MB check but over today's 4 MiB WS message cap");
    println!("(pushable only after WS_MAX_MESSAGE_SIZE is raised).");
    println!("Inflation is vs each scheme's own pushable raw bytes: schemes");
    println!("that cannot push big records look better on inflation.");
    println!("Anonymity sets are population-wide; per-user populations are smaller.");
}
