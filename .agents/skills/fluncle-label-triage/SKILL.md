---
name: fluncle-label-triage
description: Run a label triage pass — research Fluncle's undecided crawl-seed labels into DnB / not-DnB / unclear buckets with per-label evidence, propose per-artist exceptions for the mixed ones, present it all for the operator's ruling, and apply what he ratifies. Use whenever undecided labels have piled up on /admin/labels, the operator says "triage the labels", "rule on the new labels", "run a label pass/round", "sort the undecided pile", or a funnel/crawl check shows the storage gate skipping most finds because too many labels are unruled. Also the maintenance round that re-checks existing artist rules against MusicBrainz for drift. The crawler mints new undecided labels every time a round OPENS new neighbourhoods, so this is a recurring pass, not a one-off. NOT for ruling a single label the operator already named (that is one `fluncle admin labels update`), and NOT for removing already-stored off-genre content (that is fluncle-catalogue-prune).
---

# Fluncle label triage — rule the undecided crawl seeds

The catalogue crawler stores a track only when its release's label is `enabled` (the STORAGE GATE, docs/catalogue-crawler.md); a newly discovered label lands `undecided` and its releases are walked but written as nothing. So the undecided pile is the throttle on catalogue growth — and it refills itself: **every batch of enables opens new walks that mint the next batch of discoveries within hours**. This skill is the repeatable pass: pull the pile, research every label with real evidence, present the buckets, apply what the operator ratifies.

The ruling itself is an OPERATOR act (`update_label` is operator-tier — crawl scope is editorial control). The skill's job is to make each ruling a one-glance decision, never to make it.

## The exception model (why a mixed label is no longer a dead end)

`seed_state` is the label-level DEFAULT. An **artist rule** is an exception to it, and it fires on the **FIRST credited MusicBrainz artist** of a track — never a guest credit, never a name:

|                | label `enabled`                                     | label `disabled` / `undecided`                 |
| -------------- | --------------------------------------------------- | ---------------------------------------------- |
| no rule        | store                                               | skip                                           |
| artist `block` | **skip their own records** (their guest spots stay) | inert                                          |
| artist `allow` | inert                                               | **store their own records**, and nobody else's |

That gives a round two shapes the old three buckets could not express, and both change what the NEXT crawl takes while touching nothing already stored:

- **enable + blocks** — a mainly-DnB label with a recurring off-lane act. Only when the off-lane FIRST-credit share is **≤ 15 %**; above that the label is not mainly DnB and stays `unclear` for the operator.
- **`dnb_partial`: stay out of the seed set + allows** — a minority-DnB label whose DnB acts deserve the archive (the YUKU / Crucast shape). The label is left exactly as it is (undecided stays undecided); only the allow rules are written.

Four rails hold in every round:

- **Globals are never machine-applied.** A round may SUGGEST one in prose (`globalSuggestion`); the operator authors globals by hand with `fluncle admin artists rule`.
- **No inert rules.** A proposal with zero FIRST credits on the census can never fire — the block-ANY intuition proposes exactly these (measured: Maddslinky on Gutterfunk, 0 first credits). The census refuses them and `apply-rulings.py` drops any that slip through.
- **Imprint child first.** `GET /ws/2/label/<mbid>?inc=label-rels` runs BEFORE any rule proposal: when MusicBrainz already models the boundary as a child imprint (Med School under Hospital), rule that entity instead and propose no rules.
- **Conflation is still `unclear`.** One MBID holding two real labels is fixed upstream in MusicBrainz, never carved with rules.

## The pass, end to end

### 0 · Preconditions

- Operator env: `set -a; source <operator env file>; set +a` (the `set -a` matters — a plain source doesn't export to child processes). The file's location is operator topology (private companion runbook).
- Prod DB read creds resolve through `op` via the indirection var `FLUNCLE_TURSO_OP_ITEM` (the open-source posture: scripts never hardcode `op://` paths). One biometric approval covers the session. NEVER run `op signin`/`op whoami` first — in a non-TTY shell they always claim you're signed out; just run the real `op read`.

### 1 · Pull the pile

```bash
bash <skill>/scripts/pull-undecided.sh [--exclude held-slugs.txt] > undecided.json
```

Emits every `undecided` label with its **`mb_label_id`** (load-bearing: agents research the EXACT MusicBrainz entity, never a same-named label — "Absolute" the Swedish pop-comp brand is not "Absolute 2 Records" the UK jungle label), its stored-track count, and any **artist rules it already carries** (an undecided label can hold allows from a prior `dnb_partial` round). It also refreshes, in CWD:

- `calib-enabled.txt` / `calib-disabled.txt` — the operator's LIVE ruling boundary.
- `calib-rules.txt` — every ratified artist rule, one line each, with its scope and tap-bridge state: the precedent a proposal is calibrated against.
- `calib-rules.json` — the same set machine-readable, and the input to the `rescope` round.

The DB read is required: it carries the stored-track counts and the whole-corpus calibration in one query.

`--exclude` skips slugs the operator is holding for their own ear (prior rounds' `unclear`). Skipping the flag is safe — a re-triaged held label just comes back `unclear` again — it only spends tokens.

### 2 · Fan out the research

Launch the Workflow with `<skill>/scripts/triage-workflow.js`:

```
Workflow({ scriptPath: "<skill>/scripts/triage-workflow.js",
           args: { file: ".../undecided.json", enabled: ".../calib-enabled.txt",
                   disabled: ".../calib-disabled.txt", rules: ".../calib-rules.txt",
                   total: <n>, batch: 10, censusBatch: 5 } })
```

The script already guards the harness's stringified-`args` delivery (a workflow that returns instantly with zero agents IS that trap) and embeds both research briefs. It runs in two phases:

- **Research** (batch ≈ 10 labels/agent) — the three-bucket call, plus a `needsCensus` flag on any label that is genuinely two-sided.
- **Census** (batch **5** labels/agent, and ONLY the flagged ones) — the phase-2 read `?inc=artist-credits+recordings` at `limit=100`, paged to a hard 5-page cap with a verbatim sampling caveat when the cap is hit. It counts FIRST credits per MBID, applies the 15 % share test, runs the imprint-child check, and returns the rule proposals with per-artist evidence, first-credit counts, and tap-bridge status. A census verdict replaces phase 1's provisional read for that label.

The method the briefs enforce, and why:

- **Calibrate to the operator's live rulings, not a genre notion.** Agents read the calibration lists first. The boundary has a specific learned shape: majors, subsidiaries, distributors and aggregators are OUT even when they carry DnB; **DnB-specific media brands are IN** (Drum&BassArena, UKF enabled; DJ Magazine disabled); genre-adjacent scenes (dubstep, grime, UKG, jungle-adjacent electronica) are OUT.
- **MusicBrainz artists are the genre signal; MB `tags`/`genres` are usually EMPTY** — don't rely on them. Release credits (25 releases with artist-credits) decide most labels; the Discogs url-rel from the MB label settles the rest; firecrawl/web search only for what's still open. MB pacing: 1 req/s with a real User-Agent, or 403s.
- **One act is often several MBIDs.** The census expands every act it rules on into all its collaboration entities (measured: DJ Die alone was 44/130 first credits, DJ Die + DieMantle 57/130) and gives each its own rule row and count. A missed entity under-imports; it never mis-imports.
- Return `unclear` for mixed-genre labels the census cannot carve, minority-DnB catalogues not worth allow rules, or evidence too sparse to support a ruling; the operator reviews these manually.
- Return `unclear` and name the conflation when one MBID contains releases from distinct labels; enabling crawls by MBID, so split the upstream entity before enabling.
- On a partial failure (an agent dies mid-run), **resume with `resumeFromRunId`** — completed batches replay from cache, only the dead slice re-runs.

### 3 · Present for ratification

Stage the workflow's result object as `label-triage.json`, then render the review page and hand over its path:

```bash
python3 <skill>/scripts/render-ratification.py   # prints the local HTML path
```

A local file, never a hosted artifact. The page **leads with the rule proposals** — per artist: the evidence, the census first-credit count, tap-bridge status (a TAP-BLIND rule is enforced by the crawler but invisible to the freshness tap), and the census's would-take / would-drop summary — then the plain buckets with the judgment calls first (every `unclear` and every non-`high` confidence verdict). An inert proposal is flagged on the page as one that will be dropped. Global suggestions render as prose for the operator to author himself.

**Do not apply anything the operator has not ratified.**

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

The audit-only `update_artist_rule` PATCH now carries the drift stamps: `checked_at` for every sweep result, `resolved_*` from a MusicBrainz response (or null when the artist is gone). It never re-authors the rule or re-arms label scope; PATCH failures are reported separately and fail the run.

## Verification quality bar (the pass earns trust once, keeps it always)

- A wrong "enable" stores off-genre catalogue and mints public pages; a wrong "disable" silently loses good music; a wrong rule does either one artist at a time. When a verdict matters and is checkable — an ISRC in hand, a duration — spot-check via free oracles (Deezer's no-auth API) before presenting it as fact.
- Agents may challenge the brief with evidence. Live calibration lists override category rules.
- The scripts' offline behaviour is testable without credentials:
  ```bash
  python3 <skill>/scripts/apply-rulings.py apply --dry-run   # prints the planned HTTP calls
  uv run --with pytest pytest <skill>/scripts/tests/
  ```

## Where the concrete detail lives

- The storage gate, the crawl-time rule check + re-arms: docs/catalogue-crawler.md; the label entity, its seed states, and the exception model: docs/label-entity.md.
- The CLI carriers: `fluncle admin labels update` / `fluncle admin labels artists` / `fluncle admin artists rule` (docs/naming-conventions.md).
- Secrets/topology (operator env file, Turso op item): the private companion runbook. This skill holds procedure + placeholders only.
- The removal counterpart (already-stored off-genre content): the fluncle-catalogue-prune skill.
