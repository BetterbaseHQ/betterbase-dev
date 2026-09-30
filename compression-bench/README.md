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
  file-size model), fixed seeds:
  - **typical app**: 72% small (~1.2KB median) / 18% medium (~25KB) /
    8% large (~250KB) / 2% huge (~1.5MB, embedded docs) — 80% of bytes
    in the ≥256K tail.
  - **messenger-style**: 95% small / 4.5% medium / 0.5% large, no tail.
- Schemes: no padding; current 4× ladder (max 1MB); 4× extended to the
  5MB cap; next-power-of-2; Padmé; two hybrids (4× below a cutoff,
  Padmé above).
- Leak metrics: distinct observable size classes (observer resolution);
  k-anonymity — fraction of records whose padded size is shared by ≥5/50/
  500 others; **tail-anonymity** — median occupancy of the size classes
  that ≥1MB records land in (how crowded the hiding spots are for the
  sensitive embedded-doc records).
- Cost metrics: stored bytes (inflation vs each scheme's own pushable
  raw), unpushable records.

## Results (typical app; 80% of bytes in the tail)

| scheme | classes | k≥50 | k≥500 | tail-anon | storage |
|---|---|---|---|---|---|
| none | 31,384 | 1% | 0% | 1 | baseline |
| current 4× (1M) | 7 | 100% | 100% | — (unpushable) | +99% |
| extended 4× (5M) | 9 | 100% | 100% | **1,578** | **+105%** |
| next-pow-2 | 16 | 100% | 100% | **1,076** | **+44%** |
| padmé | 352 | 98% | 65% | **30** | +1% |
| hybrid 16k+padmé | 236 | 98% | 78% | 30 | +4% |
| hybrid 256k+padmé | 142 | 98% | 94% | 30 | +20% |

Messenger-style (no tail): current 4× +115% storage; pow2 +44%; padmé +2%
with 99% k≥50 / 89% k≥500.

## Findings

1. **For the sensitive tail, coarse buckets are the privacy-maximal
   choice, and Padmé is a real regression.** With ~2k embedded-doc
   records in the population, Padmé's fine granularity spreads them over
   ~70 size classes (~30 records each); the 4× ladder concentrates them
   into crowds of ~1,578; pow2 ~1,076. Per-user the effect is starker:
   a user's own ≥1MB records are few, so Padmé's tail anonymity is
   effectively 1–2 at the per-user level.
2. **For the small-record majority, every coarse ladder is strictly more
   private than Padmé** (100% k≥500 vs 65–94%). Padmé's benefit is
   almost entirely storage, not privacy.
3. **The hybrids are a storage-first construct and dissolve under a
   privacy-first frame.** Putting Padmé on the large records saves the
   most bytes exactly where sensitivity concentrates. A privacy-first
   "hybrid" (coarse high, fine low) is just… a coarse ladder.
4. **The balanced privacy-first option is next-pow-2 extended to the cap:
   +44% storage with k≥500 at 100% and tail-anon >1,000.** The maximal
   privacy option is the current 4× coarseness extended to 5MB (+105%,
   tail-anon 1,578). Both fix today's real defect: the 1MB default
   ladder makes ~1.7% of records (including the whole embedded-doc
   class) unpushable.

## Caveats

- Anonymity sets are population-wide; real observers see per-app or
  per-user populations, so absolute k-anon is weaker everywhere — the
  relative ordering is the robust takeaway.
- All schemes leak size-class *transitions over time* (growth
  trajectories); coarser ladders transition less often.
- 46 of 100k simulated records exceeded the 5MB cap itself — a
  record-design/app concern independent of padding.
- Lognormal mixtures are a model; real embedded-doc distributions should
  be measured before finalizing a ladder.
