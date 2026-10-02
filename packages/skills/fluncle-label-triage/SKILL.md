---
name: fluncle-label-triage
description: Run a label triage pass — research Fluncle's undecided crawl-seed labels into DnB / not-DnB / unclear buckets with per-label evidence, propose per-artist exceptions for the mixed ones, present it all for the operator's ruling, and apply what he ratifies. Use whenever undecided labels have piled up on /admin/labels, the operator says "triage the labels", "rule on the new labels", "run a label pass/round", "sort the undecided pile", or a funnel/crawl check shows the storage gate skipping most finds because too many labels are unruled. Also the maintenance round that re-checks existing artist rules against MusicBrainz for drift. The crawler mints new undecided labels every time a round OPENS new neighbourhoods, so this is a recurring pass, not a one-off. NOT for ruling a single label the operator already named (that is one `fluncle admin labels update`), and NOT for removing already-stored off-genre content (that is fluncle-catalogue-prune).
---

# Fluncle label triage — rule the undecided crawl seeds

The catalogue crawler stores a track only when its release's label is `enabled` (the STORAGE GATE, docs/catalogue-crawler.md); a newly discovered label lands `undecided` and its releases are walked but written as nothing. So the undecided pile is the throttle on catalogue growth — and it refills itself: **every batch of enables opens new walks that mint the next batch of discoveries within hours**. This skill is the repeatable pass: pull the pile, research every label with real evidence, present the buckets, apply what the operator ratifies.

The ruling itself is an OPERATOR decision — crawl scope is editorial control. The skill's job is to make each ruling a one-glance decision, never to make it. Applying a ratified round is mechanical, so `update_label` and the per-label exception swap accept the agent token too; global artist rules, merges and mints stay operator-tier.

## The exception model (how a mixed label gets carved)

`seed_state` is the label-level DEFAULT. An **artist rule** is an exception to it, and it fires on the **FIRST credited MusicBrainz artist** of a track — never a guest credit, never a name:

|                   | label `enabled`                                     | label `disabled` / `undecided`                 |
| ----------------- | --------------------------------------------------- | ---------------------------------------------- |
| no rule           | store                                               | skip                                           |
| artist `block`    | **skip their own records** (their guest spots stay) | inert                                          |
| artist `allow`    | inert                                               | **store their own records**, and nobody else's |
| artist `unlisted` | inert                                               | inert                                          |

**The third verdict is a different axis.** `unlisted` is GLOBAL-ONLY and VISIBILITY-ONLY: it takes the artist's public `/artist/<slug>` page off the site and changes nothing about what the crawl stores (the row above is inert on both sides by design). It is the disposition for a pop act MusicBrainz billed a drum & bass remix to — the remix stays in the archive, the pop act gets no page. A round never proposes one: the per-label PUT refuses it at the API boundary, `apply-rulings.py` refuses it before the wire, and the operator authors it by hand with `fluncle admin artists rule <mbid> --verdict unlisted`. `pull-undecided.sh` still reports existing unlisted rules in `calib-rules.txt` so the rescope round can drift-check them.

A round has two shapes beyond the plain buckets, and both change what the NEXT crawl takes while touching nothing already stored:

- **enable + blocks** — a mainly-DnB label with a recurring off-lane act. Only when the off-lane FIRST-credit share is **≤ 15 %**, measured RAW over every off-lane credit; above that the label is not mainly DnB and is never enabled: it becomes `dnb_partial` when in-lane acts carry first credits, `not_dnb` when its in-lane credits are incidental. Raw is the rail because enabling a label is a standing commitment to what it releases NEXT, which no existing rule covers. The census ALSO reports a **residual** share — the same fraction dropping credits whose artist already carries a global rule — and when the two straddle the threshold the label goes to the operator as `unclear` (`mixed`) with the gap named. The residual never changes a verdict. Measured type specimen: 0.205 raw against 0.147 residual, the gap being two already-globally-blocked acts.
- **The share is over RECORDINGS, never releases.** That is what the crawl stores: one various-artists compilation of 19 off-lane tracks imports 19 off-lane tracks, however in-lane the other releases look. A release-level reading of the same label can look twice as clean and is the wrong measure (measured: a label reading 10-of-12 releases in lane on Discogs was 43–58 % off-lane by credit).
- **`dnb_partial`: stay out of the seed set + allows** — a minority-DnB label whose DnB acts deserve the archive (the YUKU / Crucast shape). The label is left exactly as it is (undecided stays undecided); only the allow rules are written.

Four rails hold in every round:

- **Globals are never machine-applied.** A round may SUGGEST one in prose (`globalSuggestion`); the operator authors globals by hand with `fluncle admin artists rule`.
- **No inert rules.** A proposal with zero FIRST credits on the census can never fire — the block-ANY intuition proposes exactly these (measured: Maddslinky on Gutterfunk, 0 first credits). The census refuses them and `apply-rulings.py` drops any that slip through.
- **Imprint child first.** `GET /ws/2/label/<mbid>?inc=label-rels` runs BEFORE any rule proposal: when MusicBrainz already models the boundary as a child imprint (Med School under Hospital), rule that entity instead and propose no rules.
- **Conflation is never carved with rules.** One MBID holding two real labels is `unclear` when one strand is drum & bass, because the fix is an upstream MusicBrainz split that unblocks a crawl seed. When no strand is in lane it is `not_dnb`: everything the MBID would crawl is off-lane, so disabling it loses nothing.

## The pass, end to end

### 0 · Preconditions

- Operator env: `set -a; source <operator env file>; set +a` (the `set -a` matters — a plain source doesn't export to child processes). The file's location is operator topology (private companion runbook).
- Prod DB read creds resolve through `op` via the indirection var `FLUNCLE_TURSO_OP_ITEM` (the open-source posture: scripts never hardcode `op://` paths). One biometric approval covers the session. NEVER run `op signin`/`op whoami` first — in a non-TTY shell they always claim you're signed out; just run the real `op read`.

### 1 · Pull the pile

```bash
bash <skill>/scripts/pull-undecided.sh > undecided.json
```

Emits every `undecided` label with its **`mb_label_id`** (load-bearing: agents research the EXACT MusicBrainz entity, never a same-named label — "Absolute" the Swedish pop-comp brand is not "Absolute 2 Records" the UK jungle label) and its stored-track count. It also refreshes, in CWD:

- `calib-enabled.txt` / `calib-disabled.txt` — the operator's LIVE ruling boundary.
- `calib-rules.txt` — every ratified artist rule, one line each, with its scope: the precedent a proposal is calibrated against.
- `calib-rules.json` — the same set machine-readable, and the input to the `rescope` round.

The DB read is required: it carries the stored-track counts and the whole-corpus calibration in one query.

**Two exclusions, and they are the only two.** Both are exact checks rather than heuristics, and the pull names every skipped slug on stderr.

1. **A label CARRYING ARTIST RULES** is a settled `dnb_partial` — writing allows and leaving the seed state alone IS that verdict. An undecided label has no other way to acquire per-label rules. Re-triaging one would spend tokens re-deriving a ruling that exists, and applying the result would re-PUT a whole-set swap over rules the operator may have since hand-tuned.
2. **A label with no `mb_label_id`** is not researchable: nothing says which same-named MusicBrainz entity it is, and label names are not unique. Handing it to a batch invites a confident ruling on the wrong label — the namesake class, a right ruling on a wrong identity, and the one failure mode a round cannot detect afterwards. An `enabled` label without one self-resolves on its first crawl tick; an `undecided` one never gets that tick, because nothing crawls it until the operator rules, so **it is his to resolve by hand** ([docs/label-entity.md](../../../docs/label-entity.md)). One `mb_label_id` write and the next round picks the label up untouched.

The partition itself is `scripts/partition-undecided.py`, so both exclusions are unit-tested with no database (`scripts/tests/test_partition_undecided.py`).

`/admin/labels` shows the SAME split the pull does: an undecided label carrying per-label rules sits in its own _Seeding named artists_ section and is not counted in the header's "waiting on a ruling", so the station's open queue and this round's worklist are the same set ([docs/label-entity.md](../../../docs/label-entity.md)).

**There is deliberately no hold list.** Everything else undecided is triaged every round, a prior round's `unclear` included. A hold is a snapshot of a judgment, and a hand-maintained one drifts silently until it skips labels that were settled and misses labels that were not. Re-triage is cheap and self-correcting: a still-unclear label costs one slice of a research batch and comes back unclear, while a label held pending an upstream MusicBrainz split — or pending a global rule that moves its share test — RESOLVES ITSELF the first round after the fix lands, instead of waiting for someone to remember it. Do not reintroduce a slug file; if a deferral ever needs to be first-class, it belongs in the DB next to `seed_state`, which today cannot tell "never seen" from "looked at and deferred".

### 2 · Fan out the research

Launch the Workflow with `<skill>/scripts/triage-workflow.js`:

```
Workflow({ scriptPath: "<skill>/scripts/triage-workflow.js",
           args: { file: ".../undecided.json", enabled: ".../calib-enabled.txt",
                   disabled: ".../calib-disabled.txt", rules: ".../calib-rules.txt",
                   total: <n>, batch: 10, censusBatch: 5 } })
```

The script already guards the harness's stringified-`args` delivery (a workflow that returns instantly with zero agents IS that trap) and embeds both research briefs. Every brief names this file by path, so each worker reads the standing rulings and the oracle ladder below, and hands out the evidence command. It runs in two phases:

- **Research** (batch ≈ 10 labels/agent) — the three-bucket call, plus a `needsCensus` flag on any label that is genuinely two-sided.
- **Census** (batch **5** labels/agent, and ONLY the flagged ones) — the evidence command's `--census` count, applied to the 15 % share test and the imprint-child check, returning the rule proposals with per-artist evidence and first-credit counts. A census verdict replaces phase 1's provisional read for that label.

**Evidence comes from one command, never from hand-written fetchers:**

```bash
fluncle admin labels evidence <mb_label_id> --json            # research + verify
fluncle admin labels evidence <mb_label_id> --census --json   # the census
```

Run it from the repo root (`bun apps/cli/src/cli.ts admin labels evidence …` when the installed `fluncle` predates it). It reads MusicBrainz, Discogs (styles matched by release id, so a namesake never counts), Beatport's genre facet (needs `FIRECRAWL_API_KEY` or the `firecrawl` CLI) and Apple's barcode lookup, and every source reports its own `status` and `errors`. Rate limits are shared across worker processes and answers are cached for a week (`--refresh` skips the cache). `--census` counts DISTINCT recordings, the unit the crawl stores, under the same credit the crawler's artist rules read (the recording's, else the release's), so it reads lower than a per-track hand count.

The method the briefs enforce, and why:

- **Four standing rulings the operator has ratified, so a round applies them rather than re-deriving them.** (1) A **1990–1994 UK breakbeat-hardcore imprint** whose catalogue is styled Breakbeat/Hardcore with no house, techno, trance or happy-hardcore drift is IN, whether or not any release carries a Jungle tag — it is the proto-jungle shelf the archive already holds beside Ibiza Records, Production House, Suburban Base, Reinforced, Lucky Spin, Labello Blanco, Bear Necessities, Shut Up and Dance and Kickin' Underground Sound. A parent label whose hardcore SUBLABEL is the in-lane one stays out on its own merits (Kickin Records out, Kickin' Underground Sound in). (2) A **DISTRIBUTOR is out on identity, never on genre** — MusicBrainz typing the entity `Distributor`, or a Discogs page whose entries are mostly other labels' records, settles it before the catalogue is read. (3) **Two independent passes agreeing `not_dnb` at medium confidence is sufficient to DISABLE**, because the cost is asymmetric: a wrong disable stores nothing and reverses with one flag, while a wrong enable mints public pages that need the prune skill to undo. The one exception is a label that collides with another standing ruling — that goes to the operator rather than the bulk. (4) A **label whose catalogue is one release (or a handful) is decided by a DSP genre oracle, never by prose**: in-lane reading enables it, anything else disables it, and `unclear` is available only when no rung of the ladder answers at all. A previous round has already read the blurbs and failed on exactly these; the oracle is what breaks the tie.
- **The DSP oracle ladder, strongest rung first.** (1) **Apple/iTunes** — the evidence's `apple` source. Apple has a distinct `Jungle/Drum'n'bass` genre, so its ABSENCE on an electronic release is real evidence: check whether Apple applies that genre to the same artist elsewhere, and a withheld genre is a verdict rather than a gap. (2) **Beatport's genre facet** — `beatport.genres` (track counts and shares). (3) **Deezer** `api.deezer.com/album/<id>` — its `label` field also catches a rights-line entity standing in for a different imprint. (4) **Discogs** per-release styles — `discogs.styles`. (5) **Bandcamp** JSON-LD keywords. Record which rung answered and the exact string it returned; a lower rung never overrides a higher one that answered.
- **Calibrate to the operator's live rulings, not a genre notion.** Agents read the calibration lists first. The boundary has a specific learned shape: majors, subsidiaries, distributors and aggregators are OUT even when they carry DnB; **DnB-specific media brands are IN** (Drum&BassArena, UKF enabled; DJ Magazine disabled); genre-adjacent scenes (dubstep, grime, UKG, jungle-adjacent electronica) are OUT.
- **MusicBrainz artists are the genre signal; MB `tags`/`genres` are usually EMPTY** — don't rely on them. Release credits decide most labels; the Discogs and Beatport facts settle the rest; firecrawl/web search only for what's still open.
- **One act is often several MBIDs.** The census expands every act it rules on into all its collaboration entities (measured: DJ Die alone was 44/130 first credits, DJ Die + DieMantle 57/130) and gives each its own rule row and count. A missed entity under-imports; it never mis-imports.
- **`unclear` is narrow, and every other label gets a ruling.** It has exactly three reasons: `thin` (no rung of the ladder answers), `mixed` (the raw and residual shares straddle 15 %, or the census caveat leaves the share unreliable) and `conflation` (one MBID holds two real labels and one of them is drum & bass). An `unclear` has no default ruling, so it sits in the operator's queue and is re-researched every 30 days; a round that parks a decidable label there spends the operator's attention and the round's tokens on a question it could have answered. Measured: one week's box rounds returned 19 of 30 `unclear`, and 11 of the conflations among them held no drum & bass at all.
- A mixed label above 15 % is `dnb_partial` (allow every in-lane act with first credits) or `not_dnb` (its in-lane credits are incidental); a minority-DnB catalogue not worth allow rules is `not_dnb`. Both are cheap to be wrong about: an allow stores only that act's own records, and a disable reverses with one flag.
- Name the conflation in the evidence whenever one MBID contains releases from distinct labels; enabling crawls by MBID, so an in-lane strand is split upstream before enabling.
- On a partial failure (an agent dies mid-run), **resume with `resumeFromRunId`** — completed batches replay from cache, only the dead slice re-runs.

### 2b · Verify the judgment calls

The verify pass is a second opinion that tries to REFUTE each verdict with evidence the first pass did not cite, and it is the round's only defence against a confident wrong call — it has refuted roughly a fifth of what it read, including enables that would have stored off-genre catalogue and one label whose central cited claim turned out to be false. Build its input from the staged round, then run `verify-workflow.js` over it:

```bash
python3 <skill>/scripts/build-verify-input.py \
  --triage label-triage.json --pile undecided.json \
  --prior <previous round>/label-triage.json      # optional: enables the contested check
```

It selects three populations, and the second and third exist because confidence alone misses them:

- **Every medium/low-confidence `dnb` and `not_dnb`.**
- **A deterministic 10 % sample of HIGH-confidence `not_dnb`.** A disable is terminal — the pull reads only `undecided`, so a disabled label never returns to the pile and a wrong disable silently loses good music forever. High-confidence disables have never been checked, so their error rate is unmeasured rather than low. Three clean sampled rounds retire the sample (`--disable-sample 0`); one wrong disable justifies it permanently.
- **Contested reversals** — a verdict that flipped against the previous round, flagged separately when a previous verify pass had refuted it.

Merge the answers back into `label-triage.json` before rendering:

```bash
python3 <skill>/scripts/merge-verify.py --answers verify-result.json   # or the verify run's journal.jsonl
```

Every checked row ends in one outcome. **Confirmed** (same bucket at high) is promoted to high. **Unsure** (same bucket below high) keeps its verdict and confidence with both readings in its evidence, so it stays the operator's call. **Refuted** (another bucket) moves there at the verifier's confidence and drops any rules it carried, keeping both readings. **Conflicting** and **missing** rows are left exactly as they were and named on stderr, and so is a row whose answer cannot be pinned to one label (two labels sharing a fallback key, or a slug and name that point at different labels). The report counts sampled disables refuted to `dnb`, which is the wrong-disable count that decides whether the sample can retire. The script refuses answers without the verify schema (the first-pass triage journal has the same shape) and a round that already went through a verify merge, by hand or by script, so a second run cannot stack opinions. Repeat `--answers` and `--input` when a round ran more than one verify workflow.

### 3 · Present for ratification

Stage the workflow's result object as `label-triage.json`, then render the review page and hand over its path:

```bash
python3 <skill>/scripts/render-ratification.py   # prints the local HTML path
```

A local file, never a hosted artifact. The page **leads with the rule proposals** — per artist: the evidence, the census first-credit count, and the census's would-take / would-drop summary — then the plain buckets with the judgment calls first (every `unclear` and every non-`high` confidence verdict). An inert proposal is flagged on the page as one that will be dropped. Global suggestions render as prose for the operator to author himself.

**Do not apply anything the operator has not ratified.**

A round's `unclear` conflations — the ones with a drum & bass strand — get their own artefact, because they are never ruled here: they are fixed upstream and picked up clean by a later round:

```bash
python3 <skill>/scripts/render-conflation-brief.py   # writes mb-split-brief.md
```

The brief is self-contained for an editing agent driving musicbrainz.org, and it bakes in the two rules that decided real outcomes. **Group A before Group B**: a conflation with a drum & bass catalogue trapped inside unblocks a crawl seed, while one where no strand is in lane is correct MusicBrainz hygiene that earns Fluncle nothing — so the brief orders A first and says to stop rather than spend the account's standing on B. A current round rules a no-DnB conflation `not_dnb`, so Group B only fills from an older round's staged verdicts. And **the notes are a hypothesis**, confirmed against the live catalogue rather than taken as fact, with an ambiguous release left in place and reported. Both earned their place: a measured round was 10-of-23 pure hygiene, and three premises in a hand-written brief were wrong and were caught only because the editor was told to doubt them.

### 4 · Apply

```bash
python3 <skill>/scripts/apply-rulings.py pilot     # ONE label, verify the round-trip
python3 <skill>/scripts/apply-rulings.py apply     # the rest
```

Reads the staged verdicts (`label-triage.json`) and writes:

| bucket        | write                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| `dnb`         | `PATCH {seedState:"enabled"}`, then `PUT /admin/labels/{id}/artists` when it carries blocks |
| `not_dnb`     | `PATCH {seedState:"disabled"}`                                                              |
| `dnb_partial` | `PUT /admin/labels/{id}/artists` **only** — the seed state is never touched                 |
| `unclear`     | nothing                                                                                     |

It re-checks each row is STILL `undecided` server-side before writing (other sessions rule labels too), drops inert rules, refuses a row whose rule verdicts contradict its bucket, and reports per row. The rule PUT records `source: "triage"` and is a **whole-set swap that re-arms the label's crawl scope**, so rules the operator added by hand and the round did not re-propose are replaced away — the report says so. `pilot` picks a RULE-CARRYING label when the round proposed any and verifies the whole round-trip: the server's rule set matches what was sent, and `scopeChangedAt` moved.

Single labels also work through the first-class CLI: `fluncle admin labels update <slug> --seed-state enabled|disabled` and `fluncle admin labels artists <slug> [--replace --rules-file <json>]`. The API sits behind Cloudflare — every request needs a real `User-Agent` (the default `Python-urllib` signature gets a 1010).

### 5 · Close the loop

Re-count after applying and report newly minted undecided labels; offer another pass when the queue has refilled.

## The maintenance round — `rescope`

Rules age: MusicBrainz merges entities, splits them, and renames them, and a rule keyed on a merged-away MBID quietly stops matching.

```bash
python3 <skill>/scripts/apply-rulings.py rescope   # reads calib-rules.json, writes a drift report
```

Re-checks every existing rule against `GET /ws/2/artist/<mbid>` at 1 req/s and reports four shapes: **MERGED** (MusicBrainz answered with a different entity id than the one requested), **GONE** (404), **RENAMED** (the credited spelling no longer matches), **UNREACHABLE**. It writes `rescope-drift.json` and fixes nothing — an MB merge is benign until the operator decides what the rule should say, and re-authoring one re-arms that label's whole crawl scope.

The audit-only `update_artist_rule` PATCH carries the drift stamps: `checked_at` for every sweep result, `resolved_*` from a MusicBrainz response (or null when the artist is gone). It never re-authors the rule or re-arms label scope; PATCH failures are reported separately and fail the run.

## Verification quality bar (the pass earns trust once, keeps it always)

- A wrong "enable" stores off-genre catalogue and mints public pages; a wrong "disable" silently loses good music; a wrong rule does either one artist at a time. When a verdict matters and is checkable — an ISRC in hand, a duration — spot-check via free oracles (Deezer's no-auth API) before presenting it as fact.
- Agents may challenge the brief with evidence. Live calibration lists override category rules.
- The scripts' offline behaviour is testable without credentials:
  ```bash
  python3 <skill>/scripts/apply-rulings.py apply --dry-run   # prints the planned HTTP calls
  uv run --with pytest pytest <skill>/scripts/tests/
  bun test --cwd <skill>/scripts                             # every worker brief names this skill + the evidence command
  ```

## Where the concrete detail lives

- The storage gate, the crawl-time rule check + re-arms: docs/catalogue-crawler.md; the label entity, its seed states, and the exception model: docs/label-entity.md.
- The CLI carriers: `fluncle admin labels evidence` / `fluncle admin labels update` / `fluncle admin labels artists` / `fluncle admin artists rule` (docs/naming-conventions.md).
- Secrets/topology (operator env file, Turso op item): the private companion runbook. This skill holds procedure + placeholders only.
- The removal counterpart (already-stored off-genre content): the fluncle-catalogue-prune skill.
