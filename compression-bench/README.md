# CRDT blob compression benchmark

**Question:** should the sync blob pipeline compress CRDT payloads with zstd
before encrypting? (Evaluated 2026-09-30, zstd crate 0.14, Apple Silicon,
release build.)

**Today's pipeline** (frozen v1 wire format):

```
json-joy CRDT model binary → CBOR BlobEnvelope → padToBucket → AES-256-GCM (v4)
```

Nothing compresses anywhere in the pipeline, and transport-level compression
(e.g. WS permessage-deflate) cannot help: the ciphertext is already
incompressible by the time it hits the wire. The only place compression can
pay is **before** `encryptV4`, which makes it a wire-format change requiring
envelope versioning (see "Open questions").

## How to run

```bash
cd compression-bench && cargo run --release   # debug-build timings are meaningless
```

Full run takes ~45 min; `doc-60000` alone is ~20 min (per-step diff cost
grows with CRDT history while the view stays bounded). `BENCH_ONLY=<name>`
runs a substring-filtered subset, e.g. `BENCH_ONLY=note`. Results print and
flush per scenario, so partial output survives an interrupted run. Requires
the sibling repos checked out (the standard `just setup` layout).

## Method

The harness generates model binaries through the **production write path**:
`betterbase-db`'s `crdt` module (`create_model` → `diff_model` →
`apply_patch` → `model_to_binary`) over real json-joy models. It mirrors
`DEFAULT_PADDING_BUCKETS` (256B … 1MB, 4× jumps, 4-byte length prefix) so
"padded→" reflects what the server would actually store and the wire would
carry. Timings are min over 50 iterations after warm-up.

**Content realism** (this matters — an earlier draft used cycled fixed word
lists and overstated ratios by up to 10×):

- Prose comes from combinatorial grammar templates (12 sentence registers ×
  word pools): sentences are combinatorially near-unique, function words
  repeat naturally, and only intentional boilerplate ("Action item:",
  "Decision:") repeats — approximating natural-language compressibility
  without real user data.
- Notes edit like real prose: 60% append / 15% mid-document insert / 15%
  word-level revision / 10% deletion.
- Every step writes a fresh ISO `updatedAt` — production auto-fields land in
  CRDT history on every mutation.
- Monotonic counters, unique 64-bit hex item ids, varied labels/titles.
- Deterministic seeded RNG (xorshift64*): runs reproduce exactly given the
  same crate versions.

Scenarios:

| Scenario | Models | Raw size |
|---|---|---|
| `task` (20 ops) | small flat record, field flips, retitles | 840 B |
| `note` (200 / 5K / 10K ops) | prose body, mixed edit ops | 11 KB / 307 KB / 621 KB |
| `doc` (500 / 20K / 60K ops) | mixed doc mirroring json-joy-rs `bench/lessdb-realistic.cjs` shape: prose body (bounded rotation), counters, flags, tag/item churn | 48 KB / 1.19 MB / 3.8 MB |
| `churn` (2K / 50K ops) | bounded to-do list cycling items in/out — binary dominated by tombstoned ops | 46 KB / 1.21 MB |
| `merged-2actor` (600 ops) | two sessions editing independently, pending patches merged — the shape pushed after a conflict merge | 22 KB |

## Results (2026-09-30, release build, native)

| Scenario | Raw | Padded today | L1 | L3 | L9 | L19 |
|---|---|---|---|---|---|---|
| task | 840 B | 1 KB | 0.78 | 0.77 | 0.77 | 0.77 |
| note-200 | 11 KB | 16 KB | 0.55 | 0.54 | 0.53 | 0.49 |
| doc-500 | 48 KB | 64 KB | 0.51 | 0.50 | 0.47 | 0.43 |
| churn-2000 | 46 KB | 64 KB | 0.68 | 0.68 | 0.53 | 0.46 |
| merged-2actor | 22 KB | 64 KB | 0.40 | 0.38 | 0.37 | 0.35 |
| note-5000 | 307 KB | 1 MB | 0.46 | 0.45 | 0.43 | 0.33 |
| note-10000 | 621 KB | 1 MB | 0.46 | 0.45 | 0.43 | 0.32 |
| doc-20000 | 1.19 MB | **OVERFLOW** | 0.73 | 0.64 | 0.62 | 0.45 |
| churn-50000 | 1.21 MB | **OVERFLOW** | 0.70 | 0.64 | 0.60 | 0.39 |
| doc-60000 | 3.8 MB | **OVERFLOW** | 0.69 | 0.54 | 0.52 | 0.43 |

Padded-size gains (what actually lands on the server/wire — a win below the
next bucket boundary is invisible):

| Scenario | Padded today | Padded @L3 | Padded @L19 |
|---|---|---|---|
| task | 1 KB | 1 KB (0%) | 1 KB (0%) |
| note-200 | 16 KB | 16 KB (0%) | 16 KB (0%) |
| doc-500 | 64 KB | 64 KB (0%) | 64 KB (0%) |
| churn-2000 | 64 KB | 64 KB (0%) | 64 KB (0%) |
| merged-2actor | 64 KB | 16 KB (**75%**) | 16 KB (**75%**) |
| note-5000 | 1 MB | 256 KB (**75%**) | 256 KB (**75%**) |
| note-10000 | 1 MB | 1 MB (0%) | 256 KB (**75%**) |
| doc-20000 | **OVERFLOW** | 1 MB (**push rescued**) | 1 MB (**push rescued**) |
| churn-50000 | **OVERFLOW** | 1 MB (**push rescued**) | 1 MB (**push rescued**) |
| doc-60000 | **OVERFLOW** | OVERFLOW (**not rescued**) | OVERFLOW (**not rescued**) |

Timings (min of 50, native single-thread): decompress 2–5 ms worst case.
Compress: L1/L3 stay ≤ ~1.9 ms up to 1.2 MB; L19 costs 60–75 ms at ~1 MB and
**334 ms at 3.8 MB** — expect ~2–4× worse in single-threaded wasm.

## Findings

1. **Realistic ratios are 0.35–0.78 (≈1.3–2.9×), not the 5–20× the
   cycled-text draft suggested.** Natural prose with per-edit timestamps and
   unique ids compresses like ordinary mixed content. The earlier 0.04–0.06
   note ratios were an artifact of cycling a fixed word list.

2. **Overflow rescue is real but bounded.** Three scenarios exceed the 1 MB
   bucket ceiling today and fail to push (`padding overflow`). L3 rescues the
   ~1.2 MB class (doc-20000: 762 KB; churn-50000: 770 KB). But `doc-60000`
   (3.8 MB) is **not rescuable even at L19** (1.6 MB). Compression extends
   the pushable ceiling roughly 1.5×(L3)–2.4×(L19); it does not remove the
   1 MB wall. Records beyond that still need a bucket-ceiling raise or CRDT
   history compaction.

   **Size-limits context (verified 2026-09-30):** the 1 MB wall is the
   *client-side default bucket ladder*, not a server limit. The server
   accepts blobs up to 5 MB (`DEFAULT_MAX_BLOB_SIZE`, sync core), but the
   WS transport caps inbound messages at 4 MiB (`WS_MAX_MESSAGE_SIZE`),
   and no app overrides the default 1 MB ladder — so with default config
   nothing above ~1 MB is pushable, and even custom buckets could not
   exceed ~4 MiB (WS cap) despite the 5 MB storage check. "Overflow" in
   this bench therefore means default-config client-side push failure; a
   ladder raise alone (no compression) would also rescue the ~1.2 MB
   class. The two changes are alternatives with different privacy costs —
   compression shrinks payloads, a ladder raise leaks a new size class.

3. **Bucket quantization still eats most small/mid-record wins.** With 4×
   bucket jumps, 0.4–0.5 ratios rarely cross a boundary: most scenarios
   show 0% padded gain. Crossings happened for `merged-2actor` and
   `note-*`. Notably `note-10000` only crosses at L19 (0.45 → 0.32) — high
   effort occasionally unlocks a bucket drop, but at 65 ms per push.
   `merged-2actor` (0.35–0.40) compresses *better* than single-actor
   equivalents — interleaved two-session history has more repeated
   structure.

4. **Level guidance:** L1 ≈ L3 in ratio; L3 slightly better at ~1 ms/MB —
   use L3. L9 adds little. L19's 334 ms at 3.8 MB is too slow for a default
   path; if used at all, gate it to large payloads where a bucket crossing
   or overflow rescue is at stake.

## Recommendation

- Compression is **worth doing, but with modest expectations**: primary
  value is (a) raising the effective push ceiling to ~1.5–2.4 MB — fixing
  real push failures for the ~1–1.5 MB record class — and (b) large
  bandwidth/storage wins on text-heavy and multi-actor merged models.
  It is **not** a general 5× win, and it does not fix the bucket wall for
  2 MB+ records.
- If server storage of typical small/mid records is the goal, finer bucket
  granularity is the higher-leverage change.
- L3 default, skip payloads under ~1 KB, static per-blob compression only
  (no shared dictionaries — compression-oracle risk).

## Open questions / caveats

- **Wire-format versioning is required.** Encryption envelope v4 and the
  BlobEnvelope structure are frozen v1 contracts; this needs a versioned
  encoding flag with old clients able to reject/ignore cleanly.
- **Side-channel note**: compressed size is more content-dependent than raw
  size, but bucket quantization still bounds what the server learns, and the
  server cannot craft plaintexts to probe with (it cannot encrypt). Low
  risk; document in the threat model.
- This bench measures **model binaries only**, not the full CBOR envelope
  (collection name, version, edit-chain string). Envelope overhead is small,
  but edit chains (`h`) are JSON text and would compress well too — a
  prototype on the real envelope path should confirm end-to-end numbers.
- Synthetic prose approximates but does not equal real user content; if this
  moves to implementation, re-measure on sanitized real-world corpora.
- L19 in wasm is single-threaded; measure in-browser before gating any path
  on it.
- Untested tuning: mid levels (L12) or L3 with a larger window log might
  beat L3's ratio at L3's cost.

## Recorded against

- `betterbase` @ `6233fd6`, `json-joy-rs` @ `410e199` (sibling checkouts;
  see Cargo.toml)

---

# Padding scheme simulation (privacy-first)

`cargo run --release --bin padding-sim`

Companion to the compression question: given a 5MB per-blob cap, a
small-record-heavy distribution with an embedded-doc tail, and the
PURBs/Padmé paper (USENIX Security 2019) as the framework, how do padding
`schemes trade **privacy against storage**? Privacy-first: leak metrics
are the objective, storage is the price.

## Method

- Two profiles, 100k records each, lognormal mixtures (the standard
  file-size model), fixed seeds (`SEED=<hex>` env overrides for
  stability checks; numbers below are seed `0x51a1`/`0xbe5c`):
  - **typical app**: 72% small (~1.2KB median) / 18% medium (~25KB) /
    8% large (~250KB) / 2% huge (~1.5MB, embedded docs) — 80% of bytes
    in the ≥256K tail.
  - **messenger-style**: 95% small / 4.5% medium / 0.5% large, no tail.
- Schemes: no padding; current 4× ladder (max 1MB); 4× extended to the
  cap; next-power-of-2; pow2 with 4× jumps over the tail (@1M, @2M);
  Padmé; two hybrids (4× below a cutoff, Padmé above).
- **Transport constraints, as enforced in production** (verified in
  source): the server validates the *stored ciphertext blob* (padded
  payload + 13 bytes) ≤ 5MB, so the largest safe bucket is
  **5,242,867** (= 5MB − 13; buckets already include the 4-byte length
  prefix); separately, the WS transport caps
  messages at **4 MiB**, so any bucket ≥ 4 MiB produces blobs that
  exceed it today. The sim reports both: `unpush` = over the 5MB blob
  check (never pushable); `ws-strand` = legal per the 5MB check but over
  the 4 MiB WS cap (pushable only after raising `WS_MAX_MESSAGE_SIZE`).
- Leak metrics: distinct observable size classes (observer resolution);
  k-anonymity at k ≥ 500 (fraction of records whose padded size is
  shared by ≥500 others); **tail occupancy min / p10 / median** — the
  per-record occupancy distribution among ≥1MB records (the worst-off
  classes matter more than the median when the sensitive records are
  rare); per-class occupancy detail for ≥1MB classes.
- Cost metrics: mean inflation vs each scheme's own pushable raw bytes;
  per-record overhead p95 (means hide near-boundary worst cases);
  unpushable and WS-stranded counts.

## Results (typical app; 80% of bytes in the tail)

| scheme | classes | k≥500 | tail min | tail p10 | tail med | inflat | p95 | unpush | ws-strand |
|---|---|---|---|---|---|---|---|---|---|
| none | 31,384 | 0% | 1 | 1 | 1 | baseline | 0% | 46 | 50 |
| current 4× (1M) | 7 | 100% | — | — | — (unpushable) | +99% | +269% | 1,674 | 0 |
| extended 4× | 9 | 100% | 50 | 1,578 | 1,578 | +105% | +270% | 46 | 1,628 |
| pow2 (to cap) | 16 | 100% | 50 | 502 | 1,076 | **+42%** | +92% | 46 | 552 |
| pow2 + 4× tail @1M | 15 | 100% | 50 | 1,578 | 1,578 | +75% | +94% | 46 | 1,628 |
| **pow2 + 4× tail @2M** | 15 | 100% | **552** | **552** | 1,076 | +50% | +93% | 46 | 552 |
| padmé | 351 | 65% | 3 | 12 | 30 | +1% | +5% | 49 | 52 |
| hybrid 16k+padmé | 235 | 78% | 3 | 12 | 30 | +4% | +260% | 49 | 52 |
| hybrid 256k+padmé | 141 | 94% | 3 | 12 | 30 | +20% | +267% | 49 | 52 |

≥1MB class detail (bytes:occupancy): pow2 = 2M:1,076 / 4M:502 /
5,242,880:50; @2M = 2M:1,076 / 5,242,880:552 (the 4M and 5.25M classes
merge); extended 4× and @1M = 4M:1,578 / 5,242,880:50; padmé = 71
classes of 3–67.

Messenger-style (no tail): pow2 +44% (p95 +92%); the tail hybrids are
byte-identical to pow2 (coarsening never triggers); padmé +2% with 89%
k≥500. Nothing is WS-stranded (no record exceeds 4 MiB).

Multi-seed stability (3 extra seeds): pow2 tail min 44–58 / med
1,076–1,160; @2M tail min 537–609; padmé tail med 30–33; inflation
within ±1pp — conclusions are not seed artifacts. An independent expert
reimplementation (different RNG) reproduced every headline number within
Monte-Carlo noise.

## Findings

1. **The ordering is a theorem, not a simulation result: every Padmé
   class nests inside a single pow-2 bucket** (Padmé's granularity
   2^(E−S) divides 2^E, by construction). So per-record class occupancy
   under pow2 ≥ under Padmé *pointwise, for every record and every
   distribution* — consistent with the paper's own finding that Padmé
   leaks ~2× the bits of next-pow-2. Coarse ladders are the cheapest
   privacy per byte on the storage/leakage frontier; Padmé's advantage
   is storage, never privacy. This holds for the 4× ladder a fortiori.
2. **The sensitive tail: Padmé is a real regression, coarse is right —
   and the differential is trajectory leakage, not just class size.**
   Padmé spreads the ~2k embedded-doc records over ~71 classes of
   3–67 (tail med 30); the coarse ladders crowd the median doc into
   1,076–1,578. Because a lone tail record has k=1 under *any* scheme,
   the per-user argument alone is not differential; what is
   differential: (a) cross-user population k (a server correlating
   content-type hints across users), where coarse wins by the theorem
   above; and (b) growth trajectories — a doc growing 100KB→3.7MB over
   400 edits yields ~302 observable size changes across ~149 distinct
   sizes under Padmé vs ~7 under pow2 and ~2 under a 4× tail (measured
   in the independent review): Padmé turns a document's life into a
   fine-grained progress bar for the honest-but-curious server.
3. **The @2M hybrid is the worst-case winner — the metric matters.**
   Every scheme with a 4M and a 5.25M class puts the >4MB records in a
   ~50-record class: a small, *a priori identifiable* "huge document"
   class (the compression bench confirms such docs exist — doc-60000 is
   3.8MB). Merging those classes (@2M: drop the 4M bucket) lifts the
   worst-off tail class from ~50 to ~552 at +8pp storage over plain
   pow2 — invisible to the median (which stays 1,076) but decisive for
   min/p10. The real choice among pow2 / @1M / @2M is cheapest /
   max median crowd / max worst-case crowd.
4. **The balanced privacy-first default is pow-2 extended to the cap:
   +42% storage, k≥500 at 100%, tail med >1,000.** Max median-crowd
   privacy is extended 4× (+105%, tail med 1,578). Both fix today's
   defect that the 1MB default ladder strands ~1.7% of records
   (the whole embedded-doc class). Mean inflation ~1/ln 2 − 1 ≈ +44%
   per record under log-spread (the paper measured 43–47% on four real
   datasets; our totals-based estimator idealizes to 2·ln 2 − 1 ≈
   +38.6%, and lands at 42–44% because real within-bucket mass tilts
   toward bucket bottoms).
5. **Any ladder beyond 2 MiB requires raising `WS_MAX_MESSAGE_SIZE`
   first.** The server's 5MB check applies to the stored blob (bucket
   + 13), so the top bucket must be 5,242,867 — but the WS transport
   caps messages at 4 MiB, and the 4 MiB bucket's blobs (4,194,317B)
   already exceed it. Until the WS cap is raised (≥ 5MB + ε), every
   scheme strands all >2 MiB records (pow2: 552/100k; extended 4× and
   @1M: ~1,630/100k in the ws-strand column). Raising it is a small,
   versioned server/transport change and the explicit precondition for
   this ladder change. Ladder changes remain client-only otherwise
   (`unpad` is ladder-independent).
6. **Ladder uniformity is itself a privacy property.** Padded sizes are
   per-transport config, but Padmé sizes almost never coincide with
   pow2 buckets: apps overriding to a different ladder fragment the
   crowds every scheme relies on. One platform-wide default; treat
   overrides as privacy-affecting config. Cold-start also applies — at
   ~1k records even pow2's 2M class holds ~10.
7. **Sequencing with compression.** The companion bench's zstd-L3
   recommendation shrinks the embedded-doc class 0.43–0.62× (doc-20000:
   1.19MB → 762KB), which moves the tail median below 1MB and changes
   which bucket the median doc lands in. The two decisions were
   evaluated on different payload distributions; if compression ships,
   re-run this sim on the post-compression distribution (and note
   compression makes size more content-dependent) before freezing tail
   placement.

## Recommendation

Adopt **pow-2 extended to the cap, top bucket 5,242,867** as the
platform default — cheapest scheme with 100% k≥500 and tail med >1,000 —
**conditional on**:

1. Raising `WS_MAX_MESSAGE_SIZE` ≥ 5MB + ε (else the ladder effectively
   tops at 2 MiB and the >2 MiB stranding stays open, honestly labeled).
2. Deciding plain-pow2 vs @2M-tail explicitly as a risk-appetite call
   (worst-off class ~50 vs ~552, +8pp storage), informed by measured
   embedded-doc sizes — measure before freezing placement; the sim's
   1.5MB tail median is a model assumption, and @1M-vs-@2M effects are
   sensitive to it (tail median at 3MB or σ 1.0 changes absolute crowds
   ±35% but not the family ordering).
3. Re-running tail placement on the post-compression distribution if
   zstd-L3 ships.

If a future ≥2MB class becomes the sensitivity bottleneck, the
architectural answer is fixed-size chunking (pad only the final chunk;
observable becomes chunk count, tail overhead ~chunk/2 ≈ 8% at 256KB
chunks) — requires multi-blob records and wire changes; a design note,
not a near-term option. Record-slot linkage is trivial for the server
regardless of padding; size padding's job is content/activity inference,
not linkage.

## Caveats

- Anonymity sets are population-wide; real observers see per-app or
  per-user populations, so absolute k-anon is weaker everywhere — the
  relative ordering is the robust takeaway (and is a theorem, per
  finding 1).
- All schemes leak size-class transitions over time; coarser ladders
  transition less often (finding 2b).
- ~46 of 100k simulated records exceeded the 5MB cap itself — a
  record-design/app concern independent of padding.
- Lognormal mixtures are a model; sensitivity runs (tail median
  0.8–3MB, σ 0.6–1.0, tail share 2–5%, bounded-Pareto tail) leave the
  family ordering intact but swing absolute tail crowds ±35%. Measure
  real embedded-doc sizes before freezing a ladder.
- Methodology and results were reviewed by an independent expert
  (independent reimplementation, trajectory and sensitivity analyses);
  the caps, metrics, and hybrid presentation above incorporate that
  review's findings.
