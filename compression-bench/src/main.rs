//! Compression benchmark for CRDT model binaries.
//!
//! Generates model binaries through the exact production write path
//! (betterbase-db's create → diff → apply loop, json-joy under the hood),
//! then measures zstd at several levels:
//!
//!   - raw vs compressed size (ratio)
//!   - padded size before vs after compression (DEFAULT_PADDING_BUCKETS)
//!   - compress/decompress latency
//!
//! Text payloads are generated from combinatorial natural-prose templates
//! (mostly-unique sentences, realistic function-word frequency) rather than
//! cycled fixed strings — cycled text is pathologically compressible and
//! overstates ratios. Edit streams mix appends with mid-document inserts,
//! word-level revisions, and deletions, and every step bumps an ISO
//! `updatedAt` timestamp (production auto-fields land in CRDT history on
//! every mutation). A fixed seed makes runs reproducible.
//!
//! Run with `cargo run --release` — debug-build timings are meaningless.

use betterbase_db::crdt::{
    apply_patch, create_model, diff_model, merge_with_pending_patches, model_from_binary,
    model_to_binary, view_model,
};
use chrono::TimeZone;
use serde_json::{json, Value};

/// Mirror of betterbase-sync-core's DEFAULT_PADDING_BUCKETS.
const BUCKETS: &[usize] = &[256, 1024, 4096, 16384, 65536, 262144, 1048576];

/// Replicates pad_to_bucket's size selection: smallest bucket fitting
/// data + 4-byte length prefix. Returns None if it exceeds the largest.
fn padded_size(data: &[u8]) -> Option<usize> {
    BUCKETS.iter().copied().find(|&b| data.len() + 4 <= b)
}

struct Scenario {
    name: String,
    ops: usize,
    model_bin: Vec<u8>,
}

fn main() {
    // Thunks so BENCH_ONLY can filter scenarios before paying build cost.
    let all: Vec<(&str, Box<dyn FnOnce() -> Scenario>)> = vec![
        ("task", Box::new(scenario_task)),
        ("note-200", Box::new(|| scenario_note(200, 0xA11CE))),
        ("doc-500", Box::new(|| scenario_doc(500, 0xB0B))),
        ("churn-2000", Box::new(|| scenario_churn(2000, 0xC0FFEE))),
        ("merged-2actor", Box::new(|| scenario_multi_actor(300))),
        // Large models: where bucket boundaries and the 1MB overflow matter.
        ("note-5000", Box::new(|| scenario_note(5000, 0xA11CE))),
        ("note-10000", Box::new(|| scenario_note(10000, 0xA11CE))),
        ("doc-20000", Box::new(|| scenario_doc(20000, 0xB0B))),
        ("churn-50000", Box::new(|| scenario_churn(50000, 0xC0FFEE))),
        // Overflow case: fails to push today (padding overflow).
        ("doc-60000", Box::new(|| scenario_doc(60000, 0xB0B))),
    ];

    let filter = std::env::var("BENCH_ONLY").ok();
    let selected: Vec<_> = all
        .into_iter()
        .filter(|(name, _)| {
            filter
                .as_deref()
                .is_none_or(|f| name.contains(f))
        })
        .collect();
    if selected.is_empty() {
        eprintln!("BENCH_ONLY matched no scenarios");
        std::process::exit(2);
    }

    let levels = [1, 3, 9, 19];
    let timings_iters = 50;

    // Results print per scenario (and flush) so partial output survives an
    // interrupted run — the big scenarios take tens of minutes to build.
    let mut out = std::io::stdout().lock();
    use std::io::Write;

    for (name, build) in selected {
        eprintln!("building {name}...");
        let s = build();

        let padded_raw = padded_size(&s.model_bin);
        let _ = writeln!(
            out,
            "── {} ({} ops) ──\nraw {:>9} → padded {:>9} ({})",
            s.name,
            s.ops,
            s.model_bin.len(),
            padded_raw
                .map(|b| b.to_string())
                .unwrap_or_else(|| "OVERFLOW".into()),
            bucket_name(padded_raw),
        );
        let _ = writeln!(
            out,
            "{:<6} {:>9} {:>8} {:>9} {:>7} {:>7} {:>8} {:>8}",
            "level", "zstd", "ratio", "padded→", "bucket", "gain", "enc µs", "dec µs"
        );

        for level in levels {
            let c = zstd::bulk::compress(&s.model_bin, level).expect("compress");
            let padded_c = padded_size(&c);

            let enc_us = time_iters(timings_iters, || {
                zstd::bulk::compress(&s.model_bin, level).expect("compress");
            });
            let dec_us = time_iters(timings_iters, || {
                zstd::bulk::decompress(&c, s.model_bin.len()).expect("decompress");
            });

            let ratio = c.len() as f64 / s.model_bin.len() as f64;
            let _ = writeln!(
                out,
                "{:<6} {:>9} {:>8} {:>9} {:>7} {:>7} {:>8} {:>8}",
                level,
                c.len(),
                format!("{ratio:.2}"),
                padded_c
                    .map(|b| b.to_string())
                    .unwrap_or_else(|| "OVERFLOW".into()),
                bucket_name(padded_c),
                gain_str(padded_raw, padded_c),
                format!("{enc_us:.0}"),
                format!("{dec_us:.0}"),
            );
        }

        // Correctness guard: the compressed blob must round-trip exactly and
        // decode to a model with the same view as the original.
        let c = zstd::bulk::compress(&s.model_bin, 19).expect("compress");
        let d = zstd::bulk::decompress(&c, s.model_bin.len()).expect("decompress");
        assert_eq!(d, s.model_bin, "round-trip failed for {}", s.name);
        let view = view_model(&model_from_binary(&d).expect("decode model"));
        let orig = view_model(&model_from_binary(&s.model_bin).expect("decode orig"));
        assert_eq!(view, orig, "view mismatch for {}", s.name);

        let _ = writeln!(out, "round-trip OK\n");
        let _ = out.flush();
    }

    eprintln!("all scenarios done");
}

fn bucket_name(padded: Option<usize>) -> String {
    match padded {
        Some(b) => {
            let kb = b / 1024;
            if kb >= 1024 {
                format!("{}M", kb / 1024)
            } else if kb >= 1 {
                format!("{kb}K")
            } else {
                format!("{b}B")
            }
        }
        None => "—".into(),
    }
}

fn gain_str(before: Option<usize>, after: Option<usize>) -> String {
    match (before, after) {
        (Some(b), Some(a)) => {
            let pct = (1.0 - a as f64 / b as f64) * 100.0;
            format!("{pct:.0}%")
        }
        (Some(_), None) => "WORSE".into(),
        _ => "—".into(),
    }
}

fn time_iters(iters: usize, mut f: impl FnMut()) -> f64 {
    // warm-up
    for _ in 0..5 {
        f();
    }
    // Min over iterations: µs-scale timings are jitter-sensitive, and the
    // best case is the stable estimate of what the codec can do.
    let mut best = f64::INFINITY;
    for _ in 0..iters {
        let t = std::time::Instant::now();
        f();
        best = best.min(t.elapsed().as_secs_f64());
    }
    best * 1e6
}

// ── Realistic content generation ─────────────────────────────────────────────
//
// Cycled fixed strings make compression look far better than real user data:
// exact multi-word n-gram repeats are deflate candy. Natural prose instead has
// Zipf-distributed words, mostly-unique sentences, and repetition only at the
// phrase/boilerplate level. The generator below fills grammar templates from
// domain-flavored word pools: function words repeat naturally ("the", "we",
// "should"), sentences are combinatorially unique, and a small share of
// boilerplate ("Action item:", "Decision:") mirrors real notes.

/// Deterministic xorshift64* — fixed seeds keep runs reproducible.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }
}

const NOUNS: &[&str] = &[
    "meeting", "roadmap", "client", "invoice", "database", "migration", "release", "backlog",
    "design", "review", "budget", "timeline", "onboarding", "endpoint", "schema", "benchmark",
    "latency", "throughput", "credential", "backup", "cluster", "queue", "pipeline", "dashboard",
    "proposal", "contract", "vendor", "signup", "retention", "audit", "incident", "rollout",
    "pricing", "handbook", "checklist", "prototype", "dataset",
];
const VERBS: &[&str] = &[
    "review", "ship", "draft", "finish", "schedule", "migrate", "test", "deploy", "estimate",
    "triage", "refactor", "document", "validate", "roll back", "sync", "archive", "prioritize",
    "investigate", "automate", "announce", "skim", "rewrite",
];
const ADJS: &[&str] = &[
    "urgent", "blocking", "draft", "final", "quarterly", "internal", "external", "legacy",
    "stable", "experimental", "critical", "minor", "pending", "approved", "rejected", "rough",
    "stale",
];
const NAMES: &[&str] = &[
    "Dana", "Priya", "Marcus", "Elena", "Tom", "Aisha", "Jon", "Mei", "Carlos", "Sara", "Ravi",
    "Nadia",
];
const TIMES: &[&str] = &[
    "Monday", "the standup", "end of week", "lunch", "the retro", "next sprint", "the demo",
    "Friday", "the offsite", "tonight",
];

/// One natural-ish sentence: template + word pools. The template set spans
/// narrative, decision, question, and action-item registers like real notes.
fn sentence(rng: &mut Rng) -> String {
    match rng.below(12) {
        0 => format!("{} will {} the {} before {}.", rng.pick(NAMES), rng.pick(VERBS), rng.pick(NOUNS), rng.pick(TIMES)),
        1 => format!("We should {} the {} {} after {}.", rng.pick(VERBS), rng.pick(ADJS), rng.pick(NOUNS), rng.pick(TIMES)),
        2 => format!("The {} looks {}, but {} wants another pass.", rng.pick(NOUNS), rng.pick(ADJS), rng.pick(NAMES)),
        3 => format!("Decision: {} the {} next sprint.", rng.pick(VERBS), rng.pick(NOUNS)),
        4 => format!("Follow up with {} about the {} {}.", rng.pick(NAMES), rng.pick(ADJS), rng.pick(NOUNS)),
        5 => format!("Risk: the {} blocks the {} until {}.", rng.pick(NOUNS), rng.pick(NOUNS), rng.pick(TIMES)),
        6 => format!("Note from {}: {} the {} twice, then archive it.", rng.pick(NAMES), rng.pick(VERBS), rng.pick(NOUNS)),
        7 => format!("The {} {} slipped to {}; {} flagged it.", rng.pick(ADJS), rng.pick(NOUNS), rng.pick(TIMES), rng.pick(NAMES)),
        8 => format!("Action item: {} to {} the {} by {}.", rng.pick(NAMES), rng.pick(VERBS), rng.pick(NOUNS), rng.pick(TIMES)),
        9 => format!("Q: did we ever {} the {}? A: {} says yes.", rng.pick(VERBS), rng.pick(NOUNS), rng.pick(NAMES)),
        10 => format!("{} mentioned the {} is {} again.", rng.pick(NAMES), rng.pick(NOUNS), rng.pick(ADJS)),
        _ => format!("Parking lot: {} vs {}, decide by {}.", rng.pick(NOUNS), rng.pick(NOUNS), rng.pick(TIMES)),
    }
}

/// Short task-like label (title / list-item text).
fn label(rng: &mut Rng) -> String {
    match rng.below(8) {
        0 => format!("{} the {}", rng.pick(VERBS), rng.pick(NOUNS)),
        1 => format!("review {}'s {}", rng.pick(NAMES), rng.pick(NOUNS)),
        2 => format!("{} {} for {}", rng.pick(ADJS), rng.pick(NOUNS), rng.pick(NAMES)),
        3 => format!("fix the {}", rng.pick(NOUNS)),
        4 => format!("{} — waiting on {}", rng.pick(NOUNS), rng.pick(NAMES)),
        5 => format!("{} {} #{}", rng.pick(VERBS), rng.pick(NOUNS), 100 + rng.below(900)),
        6 => format!("check {} {}", rng.pick(ADJS), rng.pick(NOUNS)),
        _ => format!("{}: {} the {}", rng.pick(NAMES), rng.pick(VERBS), rng.pick(NOUNS)),
    }
}

/// Monotonic wall clock advancing 4s–5min per edit, ISO-8601 with millis —
/// the shape of production `updatedAt` auto-field writes.
struct Clock {
    ms: i64,
}

impl Clock {
    fn start() -> Self {
        Clock { ms: 1_800_000_000_000 } // 2027-ish epoch millis
    }
    fn tick(&mut self, rng: &mut Rng) -> String {
        self.ms += 4_000 + rng.below(300_000) as i64;
        chrono::Utc
            .timestamp_millis_opt(self.ms)
            .unwrap()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }
}

/// Unique 64-bit hex id standing in for production UUID item ids — full
/// width so 50k-step scenarios stay collision-free (birthday bound).
fn hex_id(rng: &mut Rng) -> String {
    format!("{:016x}", rng.next_u64())
}

// ── Scenarios ────────────────────────────────────────────────────────────────

/// Run the production write loop: create the model from the initial state,
/// then for each step diff the current view against the next state and apply.
/// The closure owns its editing state (rng, sentence list, clock) so each
/// scenario controls its own realism.
fn build(name: String, steps: usize, mut next_state: impl FnMut(usize) -> Value) -> Scenario {
    let sid = 65536;
    let initial = next_state(0);
    let mut model = create_model(&initial, sid).expect("create");
    for step in 1..=steps {
        let next = next_state(step);
        if let Some(patch) = diff_model(&model, &next) {
            apply_patch(&mut model, &patch);
        }
    }
    eprintln!("built {name}: {steps} ops");
    Scenario {
        name,
        ops: steps,
        model_bin: model_to_binary(&model),
    }
}

/// Small task-like record: field flips and retitle over its life.
fn scenario_task() -> Scenario {
    let mut rng = Rng::new(0x7A5);
    let mut clock = Clock::start();
    let mut created = None;
    let mut title = label(&mut rng);
    build(
        "task".into(),
        20,
        move |step| {
            if step == 0 {
                created = Some(clock.tick(&mut rng));
                return json!({
                    "id": "t-1",
                    "title": title,
                    "done": false,
                    "priority": 2,
                    "assignee": "alice",
                    "tags": ["errand"],
                    "createdAt": created.clone(),
                    "updatedAt": clock.tick(&mut rng),
                });
            }
            // Retitle occasionally, flip fields, bump updatedAt every edit.
            if step % 5 == 0 {
                title = label(&mut rng);
            }
            let mut tags = vec!["errand".to_string(), format!("t{}", 1 + step % 6)];
            if step % 3 == 0 {
                tags.push(label(&mut rng));
            }
            json!({
                "id": "t-1",
                "title": title,
                "done": step % 7 == 0,
                "priority": 1 + step % 4,
                "assignee": "alice",
                "tags": tags,
                "createdAt": created.clone(),
                "updatedAt": clock.tick(&mut rng),
            })
        },
    )
}

/// Note-like: a sentence list edited like real prose — mostly appends, plus
/// mid-document inserts, word-level revisions, and sentence deletions.
/// `updatedAt` bumps every edit.
fn scenario_note(steps: usize, seed: u64) -> Scenario {
    let mut rng = Rng::new(seed);
    let mut clock = Clock::start();
    let mut created = None;
    let mut title = "Meeting notes".to_string();
    let mut sents: Vec<String> = Vec::new();
    build(
        format!("note-{steps}"),
        steps,
        move |step| {
            if step == 0 {
                created = Some(clock.tick(&mut rng));
                return json!({
                    "id": "n-1",
                    "title": title,
                    "body": "",
                    "createdAt": created.clone(),
                    "updatedAt": clock.tick(&mut rng),
                });
            }
            // Edit-op distribution: append 60%, insert mid 15%, revise 15%, delete 10%.
            let roll = rng.below(100);
            if sents.is_empty() || roll < 60 {
                sents.push(sentence(&mut rng));
            } else if roll < 75 {
                let at = rng.below(sents.len() + 1);
                sents.insert(at, sentence(&mut rng));
            } else if roll < 90 {
                // Revise: swap one word in a random sentence (typo-fix / word choice)
                let idx = rng.below(sents.len());
                let words: Vec<&str> = sents[idx].split_whitespace().collect();
                if words.len() > 3 {
                    let w = rng.below(words.len());
                    let ends_punct = words[w].ends_with('.');
                    let mut replacement = rng.pick(VERBS).to_string();
                    if ends_punct {
                        replacement.push('.');
                    }
                    sents[idx] = words
                        .iter()
                        .enumerate()
                        .map(|(i, &word)| if i == w { replacement.as_str() } else { word })
                        .collect::<Vec<_>>()
                        .join(" ");
                }
            } else {
                let idx = rng.below(sents.len());
                sents.remove(idx);
            }
            // Occasional retitle
            if step % 53 == 0 {
                title = format!("Meeting notes — {}", rng.pick(TIMES));
            }
            json!({
                "id": "n-1",
                "title": title,
                "body": sents.join(" "),
                "createdAt": created.clone(),
                "updatedAt": clock.tick(&mut rng),
            })
        },
    )
}

/// Mixed document mirroring json-joy-rs bench/lessdb-realistic.cjs mutateDoc,
/// with realistic payloads: prose body (bounded rotating window so diff stays
/// cheap while history accumulates), monotonic counters, varied tags/items,
/// per-edit updatedAt.
fn scenario_doc(steps: usize, seed: u64) -> Scenario {
    let mut rng = Rng::new(seed);
    let mut clock = Clock::start();
    let mut created = None;
    let mut title = "Draft".to_string();
    let mut body: Vec<String> = Vec::new();
    let mut views = 0i64;
    let mut starred = false;
    let mut archived = false;
    let mut tags: Vec<String> = vec!["a".into(), "b".into()];
    let mut items: Vec<Value> = Vec::new();
    let mut nested_s = String::from("ab");
    build(
        format!("doc-{steps}"),
        steps,
        move |step| {
            if step == 0 {
                created = Some(clock.tick(&mut rng));
                return json!({
                    "id": "rec-1",
                    "title": title,
                    "body": "hello",
                    "tags": ["a", "b"],
                    "counters": { "views": 0, "edits": 0 },
                    "flags": { "archived": archived, "starred": starred },
                    "items": [],
                    "nested": { "s": "ab", "v": [1, 2, 3] },
                    "createdAt": created.clone(),
                    "updatedAt": clock.tick(&mut rng),
                });
            }
            if step % 17 == 0 {
                title = format!("Draft — {}", label(&mut rng));
            }
            // Prose body: append a sentence, rotate out the oldest past 400.
            body.push(sentence(&mut rng));
            if body.len() > 400 {
                body.remove(0);
            }
            views += 1 + rng.below(3) as i64;
            starred = step % 2 == 0;
            if step % 5 == 0 {
                archived = !archived;
            }
            tags.push(label(&mut rng));
            if tags.len() > 8 {
                tags.remove(0);
            }
            items.push(json!({
                "id": hex_id(&mut rng),
                "label": label(&mut rng),
                "done": step % 2 == 1,
            }));
            if items.len() > 10 {
                items.remove(0);
            }
            // Short string field that churns like the original bench's nested.s
            nested_s = format!("{}{}", nested_s, hex_id(&mut rng));
            let start = nested_s.len().saturating_sub(24);
            nested_s.replace_range(..start, "");
            let v = [0i64; 3].map(|_| rng.below(10_000) as i64);
            json!({
                "id": "rec-1",
                "title": title,
                "body": body.join(" "),
                "tags": tags,
                "counters": { "views": views, "edits": step },
                "flags": { "archived": archived, "starred": starred },
                "items": items,
                "nested": { "s": nested_s, "v": v },
                "createdAt": created.clone(),
                "updatedAt": clock.tick(&mut rng),
            })
        },
    )
}

/// Tombstone-heavy: a bounded to-do list where items cycle in and out, so the
/// model binary is dominated by dead ops. Varied labels + unique hex ids.
fn scenario_churn(steps: usize, seed: u64) -> Scenario {
    let mut rng = Rng::new(seed);
    let mut clock = Clock::start();
    let mut created = None;
    let mut items: Vec<Value> = Vec::new();
    build(
        format!("churn-{steps}"),
        steps,
        move |step| {
            if step == 0 {
                created = Some(clock.tick(&mut rng));
                return json!({
                    "id": "c-1",
                    "items": [],
                    "createdAt": created.clone(),
                    "updatedAt": clock.tick(&mut rng),
                });
            }
            items.push(json!({
                "id": hex_id(&mut rng),
                "label": label(&mut rng),
                "done": false,
            }));
            if items.len() > 6 {
                items.remove(0);
            }
            // Flip a pre-existing item (not the one just pushed) so in-place
            // boolean edits enter history, like real checkbox usage.
            if step % 2 == 0 && items.len() > 1 {
                let idx = rng.below(items.len() - 1);
                items[idx]["done"] = json!(true);
            }
            json!({
                "id": "c-1",
                "items": items,
                "createdAt": created.clone(),
                "updatedAt": clock.tick(&mut rng),
            })
        },
    )
}

/// Multi-actor merged model: two sessions edit the same note independently,
/// then one merges the other's pending patches — the shape of a blob pushed
/// after a conflict merge (peer clock table + interleaved history).
fn scenario_multi_actor(steps: usize) -> Scenario {
    let sid_a = 65536;
    let sid_b = 65537;
    let mut rng_a = Rng::new(0xD00D);
    let mut rng_b = Rng::new(0xF00D);
    let mut clock_a = Clock::start();
    let mut clock_b = Clock::start();
    let created: Option<String>;

    let mut sents_a: Vec<String> = Vec::new();
    let mut sents_b: Vec<String> = Vec::new();
    let mut title_b = "Shared doc".to_string();

    let mut a = {
        let initial = json!({
            "id": "m-1",
            "title": "Shared doc",
            "body": "start",
            "counters": { "edits": 0 },
        });
        created = Some(clock_a.tick(&mut rng_a));
        create_model(&initial, sid_a).expect("create a")
    };
    let mut b = {
        let initial = json!({
            "id": "m-1",
            "title": "Shared doc",
            "body": "start",
            "counters": { "edits": 0 },
        });
        let _ = clock_b.tick(&mut rng_b);
        create_model(&initial, sid_b).expect("create b")
    };

    let mut cur_a = json!({
        "id": "m-1",
        "title": "Shared doc",
        "body": "start",
        "counters": { "edits": 0 },
        "createdAt": created.clone(),
        "updatedAt": clock_a.tick(&mut rng_a),
    });
    let mut cur_b = json!({
        "id": "m-1",
        "title": "Shared doc",
        "body": "start",
        "counters": { "edits": 0 },
        "createdAt": created.clone(),
        "updatedAt": clock_b.tick(&mut rng_b),
    });
    let mut b_patches = Vec::new();

    for step in 1..=steps {
        // A appends prose and bumps its edit counter.
        sents_a.push(sentence(&mut rng_a));
        cur_a["counters"]["edits"] = json!(step);
        cur_a["body"] = json!(sents_a.join(" "));
        cur_a["updatedAt"] = json!(clock_a.tick(&mut rng_a));
        if let Some(p) = diff_model(&a, &cur_a) {
            apply_patch(&mut a, &p);
        }

        // B retitles occasionally and appends different prose.
        sents_b.push(sentence(&mut rng_b));
        if step % 23 == 0 {
            title_b = format!("Shared doc — {}", rng_b.pick(TIMES));
        }
        cur_b["title"] = json!(title_b);
        cur_b["body"] = json!(sents_b.join(" "));
        cur_b["updatedAt"] = json!(clock_b.tick(&mut rng_b));
        if let Some(p) = diff_model(&b, &cur_b) {
            apply_patch(&mut b, &p);
            b_patches.push(p);
        }
    }

    // Merge B's pending patches into a replica of A's final model — the
    // production conflict-merge shape.
    let a_bin = model_to_binary(&a);
    let mut merged = model_from_binary(&a_bin).expect("decode a");
    merge_with_pending_patches(&mut merged, &b_patches);

    Scenario {
        name: "merged-2actor".into(),
        ops: steps * 2,
        model_bin: model_to_binary(&merged),
    }
}
