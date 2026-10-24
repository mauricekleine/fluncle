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
                   total: <n>, batch: 10, censusBatch: 5, concurrency: 6,
                   roundDir: "<durable round directory>" } })
```

`concurrency` defaults to 6 and caps workers in each phase. Give the round a durable directory outside session scratch, for example `$XDG_STATE_HOME/fluncle/label-triage/<run-id>` (use `~/.local/state` when unset). Pass its absolute path as `roundDir` to both workflows. Each batch appends its run id, slice, label states and output files to `<roundDir>/manifest.jsonl`; the latest attempt for a slice describes its current state. Keep that manifest with the workflow journal for resume and transcript measurement.

The phases are **Research** (about 10 labels per agent) and **Census** (5 mixed labels per agent). Census verdicts replace provisional research verdicts. Every worker reads [worker-rulings.md](references/worker-rulings.md) once with the file-read tool for the standing boundary and oracle ladder; the full coordinator skill stays here.

**Collect one batch per command and read the text summaries first:**

```bash
fluncle admin labels evidence <mbid-1> <mbid-2> --out <roundDir>/research-0 --manifest <roundDir>/manifest.jsonl
fluncle admin labels evidence <mbid-1> <mbid-2> --census --out <roundDir>/census-0 --manifest <roundDir>/manifest.jsonl
```

The CLI collects labels serially under the shared source limiters, atomically writes JSON and text files named by resolved MusicBrainz MBID, and prints one manifest line per label with its id, source statuses and paths. Workers use the returned summaries and open saved JSON with the file-read tool only for fields that decide a ruling. The briefs scale the command deadline to the batch (240 s per label, capped at 540 s below the 600 s tool timeout); single-label commands keep the normal 240 s default and exit 124. Run the command once in the foreground; if the tool returns a task handle, use its blocking completion tool. The coordinator resumes interrupted/failed slices from the manifest and cached source responses at lower concurrency before accepting their verdicts. `--refresh` skips the week-long cache.

JSON shape: top-level `label`, `fetchedAt`, `ok`, `partial`, `requests`, `errors`, `sources`. `sources.apple`, `.beatport`, `.discogs`, `.musicbrainz` each has `status`: `ok`, `partial`, `error`, `no_link`, `not_configured`, `skipped`; `data`, `errors`, `note`, `cached` can be absent. Nullable fields: MusicBrainz label `area`, `country`, `disambiguation`, `type`, `labelCode`, life-span `begin`/`end`; release `barcode`, `catno`, `date`, `format`, `status`; census `caveat`; Discogs `parentLabel`, release `catno`, `format`, `year`. Apple unmatched releases omit genre/artist/title fields. Census first credits are at `sources.musicbrainz.data.census.firstCredits`, with `recordingsCounted` as denominator and `labelRelations` under `.data.label`. A source status is collection state, not a genre verdict.

`--census` counts DISTINCT recordings using the crawler's first credit (recording, else release), under the same shared MusicBrainz limiter. Beatport needs `FIRECRAWL_API_KEY` or the Firecrawl CLI. Research extra web sources only when the returned evidence leaves a question open; use the command for the sources it already covers. On partial workflow failure, resume with `resumeFromRunId`: completed batches replay from cache and only dead slices rerun.

### 2a · Stage the round

Merge the research and census task results from the workflow journal before building the verify input:

```bash
python3 <skill>/scripts/merge-round.py \
  --journal <triage run>/journal.jsonl --scope undecided.json \
  --round <round number> --out label-triage.json
```

`--scope` is the exact label array the research workflow read; use its subset file when the round only researched part of the pile. Repeat `--journal` for separate research and census runs. Paths are explicit, `--round` optionally records the round number, and omitting `--out` emits JSON on stdout. Census results replace provisional research verdicts after both phases resolve their slugs against the scope: an exact slug, a unique punctuation-free slug, or a unique label name. A repaired row retains `_slugFixedFrom`. Ambiguous matches, conflicting slug/name identities, duplicate verdicts and verify answers are refused before writing output; repeated results for the same task key use the latest result once. The counts describe the final buckets, applied census replacements and proposed rules.

Read stderr before continuing: missing research labels and pending census labels are named there, and a census-only label is reported without adding it to the round. Resume missing workflow tasks and re-run this merge from their journals until every scoped label has a research verdict and every `needsCensus` label has its census. This stages the first pass; `merge-verify.py` below handles second opinions.

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

Render the staged, verified `label-triage.json` and hand over the review page's path:

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
  bun run test:label-triage:python                           # from the repo root; pinned Python + pytest through uv
  bun test --cwd <skill>/scripts                             # every worker brief names this skill + the evidence command
  ```

## Where the concrete detail lives

- The storage gate, the crawl-time rule check + re-arms: docs/catalogue-crawler.md; the label entity, its seed states, and the exception model: docs/label-entity.md.
- The CLI carriers: `fluncle admin labels evidence` / `fluncle admin labels update` / `fluncle admin labels artists` / `fluncle admin artists rule` (docs/naming-conventions.md).
- Secrets/topology (operator env file, Turso op item): the private companion runbook. This skill holds procedure + placeholders only.
- The removal counterpart (already-stored off-genre content): the fluncle-catalogue-prune skill.
