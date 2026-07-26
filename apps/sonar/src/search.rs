//! The search contract (wire types) and the query orchestration: validate +
//! normalize probes, build the candidate predicate (metadata filter + exclude
//! set), run the kernel scan, map entry indices back to ids.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::decode::DIM;
use crate::index::{normalize_in_place, Index, TrackMeta};
use crate::kernel;

/// Which in-memory index a query targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexName {
    Tracks,
    Centroids,
}

/// Optional metadata filter. A `None` field is unconstrained. A constraint that
/// is `Some` requires the entry to carry the field and satisfy it — so any
/// metadata constraint excludes centroid entries (which have no metadata).
///
/// `deny_unknown_fields` IS A SAFETY PROPERTY, NOT STRICTNESS. serde ignores unknown
/// fields by default, so a Worker that sends a constraint this binary does not know
/// would have it SILENTLY DROPPED and get back a wider candidate set with no error —
/// dismissed, duplicate, or long-form tracks on a listener's page, indistinguishable
/// from a correct answer. Refusing the body instead makes the request fail to parse,
/// which the handler answers as an EMPTY result, which every call site treats as the
/// documented fallback signal: the surface degrades to the Turso exact scan. Correct,
/// just slower. That is the only acceptable failure mode for a version skew between
/// the Worker and a box that has not yet self-deployed this binary.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    pub key_in: Option<Vec<String>>,
    pub bpm_min: Option<f32>,
    pub bpm_max: Option<f32>,
    pub anchored: Option<bool>,
    pub certified: Option<bool>,
    /// Require/forbid ANY findings row. NOT `certified` — see [`TrackMeta::has_finding`].
    pub has_finding: Option<bool>,
    pub dismissed: Option<bool>,
    pub is_duplicate: Option<bool>,
    /// EXCLUSIVE upper bound on `nearest_finding_score`, and **a NULL score PASSES** —
    /// the SQL being mirrored is `(score is null or score < x)`. Unlike `bpm_max`
    /// (inclusive, and a missing bpm fails), this pair is deliberately asymmetric.
    pub nearest_finding_score_max: Option<f32>,
    /// EXCLUSIVE upper bound on `duration_ms`, and **a NULL duration FAILS** — the SQL
    /// being mirrored is `duration_ms < x`, and `NULL < x` is NULL, so the row is
    /// excluded. The opposite null rule to `nearest_finding_score_max`, on purpose.
    pub duration_ms_max: Option<u32>,
}

/// A `POST /search` request body.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    pub index: IndexName,
    /// One or more query vectors, each [`DIM`] long. Scored as the max dot over
    /// all probes (nearest-probe), never averaged.
    pub probes: Vec<Vec<f32>>,
    #[serde(default)]
    pub filter: Option<Filter>,
    #[serde(default)]
    pub exclude_ids: Option<Vec<String>>,
    pub top_k: usize,
}

/// A single scored result. `score` is cosine similarity (higher == nearer).
#[derive(Debug, Clone, Serialize)]
pub struct Match {
    pub id: String,
    pub score: f32,
}

/// A `POST /search` response body.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub matches: Vec<Match>,
}

impl SearchResponse {
    pub fn empty() -> Self {
        Self {
            matches: Vec::new(),
        }
    }
}

/// Does an entry's metadata satisfy the filter? A `Some` constraint on a field
/// the entry lacks (e.g. any metadata filter against a centroid) fails.
fn passes_filter(meta: Option<&TrackMeta>, filter: &Filter) -> bool {
    if let Some(keys) = &filter.key_in {
        match meta.and_then(|m| m.key.as_deref()) {
            Some(k) if keys.iter().any(|want| want == k) => {}
            _ => return false,
        }
    }
    if let Some(min) = filter.bpm_min {
        match meta.and_then(|m| m.bpm) {
            Some(b) if b >= min => {}
            _ => return false,
        }
    }
    if let Some(max) = filter.bpm_max {
        match meta.and_then(|m| m.bpm) {
            Some(b) if b <= max => {}
            _ => return false,
        }
    }
    if let Some(want) = filter.anchored {
        match meta.map(|m| m.anchored) {
            Some(v) if v == want => {}
            _ => return false,
        }
    }
    if let Some(want) = filter.certified {
        match meta.map(|m| m.certified) {
            Some(v) if v == want => {}
            _ => return false,
        }
    }
    if let Some(want) = filter.has_finding {
        match meta.map(|m| m.has_finding) {
            Some(v) if v == want => {}
            _ => return false,
        }
    }
    if let Some(want) = filter.dismissed {
        match meta.map(|m| m.dismissed) {
            Some(v) if v == want => {}
            _ => return false,
        }
    }
    if let Some(want) = filter.is_duplicate {
        match meta.map(|m| m.is_duplicate) {
            Some(v) if v == want => {}
            _ => return false,
        }
    }
    if let Some(max) = filter.nearest_finding_score_max {
        // NULL PASSES: `(score is null or score < max)`. An entry with no metadata at
        // all (a centroid) still fails, like every other constraint.
        match meta.map(|m| m.nearest_finding_score) {
            Some(None) => {}
            Some(Some(score)) if score < max => {}
            _ => return false,
        }
    }
    if let Some(max) = filter.duration_ms_max {
        // NULL FAILS: `duration_ms < max`, and SQL's `NULL < max` is NULL ⇒ excluded.
        match meta.and_then(|m| m.duration_ms) {
            Some(duration) if duration < max => {}
            _ => return false,
        }
    }
    true
}

/// Run a search over `index`. Invalid input (empty probes, wrong-dim probe,
/// `top_k == 0`) yields an empty response rather than an error — never panics.
pub fn search(index: &Index, req: &SearchRequest) -> SearchResponse {
    if req.top_k == 0 || req.probes.is_empty() {
        return SearchResponse::empty();
    }

    // Normalize each probe; a wrong-dimension probe makes the whole request
    // invalid → empty result.
    let mut probes: Vec<Vec<f32>> = Vec::with_capacity(req.probes.len());
    for p in &req.probes {
        if p.len() != DIM {
            return SearchResponse::empty();
        }
        let mut v = p.clone();
        normalize_in_place(&mut v);
        probes.push(v);
    }

    let exclude: HashSet<&str> = req
        .exclude_ids
        .as_ref()
        .map(|ids| ids.iter().map(String::as_str).collect())
        .unwrap_or_default();

    let default_filter = Filter::default();
    let filter = req.filter.as_ref().unwrap_or(&default_filter);

    let keep = |i: usize| -> bool {
        if !exclude.is_empty() && exclude.contains(index.id_at(i)) {
            return false;
        }
        passes_filter(index.meta_at(i), filter)
    };

    let scored = kernel::scan(index, &probes, req.top_k, keep);

    let matches = scored
        .into_iter()
        .map(|(i, score)| Match {
            id: index.id_at(i).to_string(),
            score,
        })
        .collect();

    SearchResponse { matches }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Entry;

    fn padded(values: &[f32]) -> Vec<f32> {
        let mut v = values.to_vec();
        v.resize(DIM, 0.0);
        v
    }

    fn track(id: &str, vec: Vec<f32>, meta: TrackMeta) -> Entry {
        Entry {
            id: id.into(),
            vector: vec,
            meta: Some(meta),
        }
    }

    fn req(probes: Vec<Vec<f32>>, top_k: usize) -> SearchRequest {
        SearchRequest {
            index: IndexName::Tracks,
            probes,
            filter: None,
            exclude_ids: None,
            top_k,
        }
    }

    #[test]
    fn top_k_ordering_by_similarity() {
        let index = Index::from_entries(vec![
            track("near", padded(&[1.0, 0.0]), TrackMeta::default()),
            track("mid", padded(&[0.7, 0.7]), TrackMeta::default()),
            track("far", padded(&[0.0, 1.0]), TrackMeta::default()),
        ]);
        let resp = search(&index, &req(vec![padded(&[1.0, 0.0])], 3));
        assert_eq!(resp.matches.len(), 3);
        assert_eq!(resp.matches[0].id, "near");
        assert_eq!(resp.matches[1].id, "mid");
        assert_eq!(resp.matches[2].id, "far");
        // scores are strictly descending
        assert!(resp.matches[0].score >= resp.matches[1].score);
        assert!(resp.matches[1].score >= resp.matches[2].score);
    }

    #[test]
    fn top_k_truncates() {
        let index = Index::from_entries(vec![
            track("a", padded(&[1.0, 0.0]), TrackMeta::default()),
            track("b", padded(&[0.9, 0.1]), TrackMeta::default()),
            track("c", padded(&[0.0, 1.0]), TrackMeta::default()),
        ]);
        let resp = search(&index, &req(vec![padded(&[1.0, 0.0])], 2));
        assert_eq!(resp.matches.len(), 2);
        assert_eq!(resp.matches[0].id, "a");
        assert_eq!(resp.matches[1].id, "b");
    }

    /// Multi-probe: a candidate that perfectly matches one probe ranks first even
    /// though it is orthogonal to the other probe (nearest, not centroid).
    #[test]
    fn multi_probe_nearest_wins() {
        let index = Index::from_entries(vec![
            track("matches_p2", padded(&[0.0, 1.0]), TrackMeta::default()),
            track("centroidish", padded(&[0.7, 0.7]), TrackMeta::default()),
        ]);
        let r = search(
            &index,
            &req(vec![padded(&[1.0, 0.0]), padded(&[0.0, 1.0])], 2),
        );
        // matches_p2 == p2 exactly → score ~1.0, beats the 45° centroid-ish one.
        assert_eq!(r.matches[0].id, "matches_p2");
        assert!((r.matches[0].score - 1.0).abs() < 1e-5);
    }

    #[test]
    fn exclude_ids_removes_candidates() {
        let index = Index::from_entries(vec![
            track("keep", padded(&[1.0, 0.0]), TrackMeta::default()),
            track("drop", padded(&[1.0, 0.0]), TrackMeta::default()),
        ]);
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);
        r.exclude_ids = Some(vec!["drop".into()]);
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "keep");
    }

    #[test]
    fn metadata_filter_key_bpm_anchored_certified() {
        let index = Index::from_entries(vec![
            track(
                "amin_174_anc_cert",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    key: Some("Amin".into()),
                    bpm: Some(174.0),
                    anchored: true,
                    certified: true,
                    ..TrackMeta::default()
                },
            ),
            track(
                "gmaj_140_unanc_uncert",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    key: Some("Gmaj".into()),
                    bpm: Some(140.0),
                    anchored: false,
                    certified: false,
                    ..TrackMeta::default()
                },
            ),
        ]);

        // key filter
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);
        r.filter = Some(Filter {
            key_in: Some(vec!["Amin".into()]),
            ..Default::default()
        });
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "amin_174_anc_cert");

        // bpm range
        r.filter = Some(Filter {
            bpm_min: Some(160.0),
            bpm_max: Some(180.0),
            ..Default::default()
        });
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "amin_174_anc_cert");

        // anchored + certified
        r.filter = Some(Filter {
            anchored: Some(false),
            certified: Some(false),
            ..Default::default()
        });
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "gmaj_140_unanc_uncert");
    }

    #[test]
    fn metadata_filter_excludes_entries_without_metadata() {
        // A centroid-style entry (meta None) is excluded by ANY metadata filter.
        let index = Index::from_entries(vec![Entry {
            id: "centroid".into(),
            vector: padded(&[1.0, 0.0]),
            meta: None,
        }]);
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);
        r.filter = Some(Filter {
            certified: Some(true),
            ..Default::default()
        });
        assert!(search(&index, &r).matches.is_empty());
    }

    /// `certified` and `has_finding` are DIFFERENT facts, and the difference is the whole
    /// reason the catalogue predicate can route: the coordinate-less straggler (a findings
    /// row whose `log_id` is still NULL) passes `certified: false` and must NOT pass
    /// `has_finding: false`. `/recommendations` negates the LATTER (`f.track_id is null`).
    #[test]
    fn has_finding_is_not_certified() {
        let straggler = TrackMeta {
            certified: false,
            has_finding: true,
            ..Default::default()
        };
        let catalogue = TrackMeta {
            certified: false,
            has_finding: false,
            ..Default::default()
        };
        let index = Index::from_entries(vec![
            track("straggler", padded(&[1.0, 0.0]), straggler),
            track("catalogue", padded(&[1.0, 0.0]), catalogue),
        ]);

        // The weaker negation admits both — the trap this test exists to pin.
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);
        r.filter = Some(Filter {
            certified: Some(false),
            ..Default::default()
        });
        assert_eq!(search(&index, &r).matches.len(), 2);

        // The catalogue's actual predicate admits only the row with no findings row at all.
        r.filter = Some(Filter {
            has_finding: Some(false),
            ..Default::default()
        });
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "catalogue");
    }

    #[test]
    fn dismissed_and_duplicate_constraints() {
        let index = Index::from_entries(vec![
            track(
                "clean",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    ..Default::default()
                },
            ),
            track(
                "dismissed",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    dismissed: true,
                    ..Default::default()
                },
            ),
            track(
                "duplicate",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    is_duplicate: true,
                    ..Default::default()
                },
            ),
        ]);
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);
        r.filter = Some(Filter {
            dismissed: Some(false),
            is_duplicate: Some(false),
            ..Default::default()
        });
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "clean");
    }

    /// NULL SEMANTICS, HALF ONE. `nearest_finding_score_max` mirrors
    /// `(score is null or score < x)` — a row with NO score PASSES, and the bound is
    /// EXCLUSIVE (a row sitting exactly on the threshold is out).
    #[test]
    fn nearest_finding_score_max_lets_a_null_score_through() {
        let index = Index::from_entries(vec![
            track(
                "null_score",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    nearest_finding_score: None,
                    ..Default::default()
                },
            ),
            track(
                "under_band",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    nearest_finding_score: Some(0.8),
                    ..Default::default()
                },
            ),
            track(
                "on_band",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    nearest_finding_score: Some(0.995),
                    ..Default::default()
                },
            ),
            track(
                "over_band",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    nearest_finding_score: Some(0.999),
                    ..Default::default()
                },
            ),
        ]);
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);
        r.filter = Some(Filter {
            nearest_finding_score_max: Some(0.995),
            ..Default::default()
        });
        let mut ids: Vec<String> = search(&index, &r)
            .matches
            .into_iter()
            .map(|m| m.id)
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["null_score".to_string(), "under_band".to_string()]
        );
    }

    /// NULL SEMANTICS, HALF TWO — the OPPOSITE rule, and the asymmetry is the point.
    /// `duration_ms_max` mirrors a bare `duration_ms < x`, and SQL's `NULL < x` is NULL, so
    /// a row with NO duration is EXCLUDED. Asserted against the null-score case above.
    #[test]
    fn duration_ms_max_excludes_a_null_duration() {
        let index = Index::from_entries(vec![
            track(
                "null_duration",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    duration_ms: None,
                    ..Default::default()
                },
            ),
            track(
                "short",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    duration_ms: Some(270_000),
                    ..Default::default()
                },
            ),
            track(
                "exactly_long_form",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    duration_ms: Some(900_000),
                    ..Default::default()
                },
            ),
            track(
                "long_form",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    duration_ms: Some(1_800_000),
                    ..Default::default()
                },
            ),
        ]);
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);
        r.filter = Some(Filter {
            duration_ms_max: Some(900_000),
            ..Default::default()
        });
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "short");
    }

    /// The two null rules, side by side on ONE entry, so the asymmetry cannot drift apart:
    /// the same row passes the score bound (null ⇒ in) and fails the duration bound
    /// (null ⇒ out).
    #[test]
    fn the_two_null_rules_are_deliberately_opposite() {
        let both_null = TrackMeta {
            duration_ms: None,
            nearest_finding_score: None,
            ..Default::default()
        };
        let index = Index::from_entries(vec![track("row", padded(&[1.0, 0.0]), both_null)]);
        let mut r = req(vec![padded(&[1.0, 0.0])], 5);

        r.filter = Some(Filter {
            nearest_finding_score_max: Some(0.995),
            ..Default::default()
        });
        assert_eq!(search(&index, &r).matches.len(), 1, "a null score PASSES");

        r.filter = Some(Filter {
            duration_ms_max: Some(900_000),
            ..Default::default()
        });
        assert!(
            search(&index, &r).matches.is_empty(),
            "a null duration FAILS"
        );
    }

    /// The FULL `/recommendations` catalogue predicate, expressed as one filter, over a
    /// fixture world holding one row of each excluded class. Only the eligible row survives.
    #[test]
    fn the_catalogue_eligibility_predicate_composes() {
        fn eligible() -> TrackMeta {
            TrackMeta {
                anchored: true,
                duration_ms: Some(270_000),
                ..Default::default()
            }
        }
        let index = Index::from_entries(vec![
            track("eligible", padded(&[1.0, 0.0]), eligible()),
            track(
                "unanchored",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    anchored: false,
                    ..eligible()
                },
            ),
            track(
                "certified",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    certified: true,
                    has_finding: true,
                    ..eligible()
                },
            ),
            track(
                "coordinate_less_straggler",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    certified: false,
                    has_finding: true,
                    ..eligible()
                },
            ),
            track(
                "dismissed",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    dismissed: true,
                    ..eligible()
                },
            ),
            track(
                "duplicate",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    is_duplicate: true,
                    ..eligible()
                },
            ),
            track(
                "display_duplicate",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    nearest_finding_score: Some(0.999),
                    ..eligible()
                },
            ),
            track(
                "long_form",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    duration_ms: Some(1_800_000),
                    ..eligible()
                },
            ),
            track(
                "null_duration",
                padded(&[1.0, 0.0]),
                TrackMeta {
                    duration_ms: None,
                    ..eligible()
                },
            ),
        ]);
        let mut r = req(vec![padded(&[1.0, 0.0])], 20);
        r.filter = Some(Filter {
            anchored: Some(true),
            dismissed: Some(false),
            duration_ms_max: Some(900_000),
            has_finding: Some(false),
            is_duplicate: Some(false),
            nearest_finding_score_max: Some(0.995),
            ..Default::default()
        });
        let resp = search(&index, &r);
        assert_eq!(resp.matches.len(), 1);
        assert_eq!(resp.matches[0].id, "eligible");
    }

    /// FAIL CLOSED on a field this binary does not know. serde's DEFAULT is to ignore an
    /// unknown key, which would let a NEWER Worker's constraint be silently dropped by an
    /// OLDER binary — a wider candidate set with no error. `deny_unknown_fields` turns that
    /// into a parse failure, which the handler answers as an empty result, which every call
    /// site reads as "fall back to Turso".
    #[test]
    fn an_unknown_filter_field_is_rejected() {
        let body = r#"{"certified":true,"not_a_real_field":true}"#;
        assert!(serde_json::from_str::<Filter>(body).is_err());
    }

    /// …and the FOUR already-live surfaces are unaffected: each sends a SUBSET of the known
    /// fields, and a missing field deserializes to `None` (unconstrained), exactly as before.
    #[test]
    fn the_live_surfaces_filters_still_deserialize() {
        // Sonic search + /log neighbours + the /recommendations findings slots.
        let certified_only: Filter = serde_json::from_str(r#"{"certified":true}"#).unwrap();
        assert_eq!(certified_only.certified, Some(true));
        assert_eq!(certified_only.has_finding, None);
        assert_eq!(certified_only.duration_ms_max, None);

        // Sonic search, broad: anchored-only.
        let anchored_only: Filter = serde_json::from_str(r#"{"anchored":true}"#).unwrap();
        assert_eq!(anchored_only.anchored, Some(true));

        // The /mix rail: a key set with no other constraint.
        let mix: Filter = serde_json::from_str(r#"{"key_in":["Amin","Cmaj"]}"#).unwrap();
        assert_eq!(mix.key_in.as_deref().map(<[String]>::len), Some(2));
        assert_eq!(mix.bpm_min, None);

        // /artists?like= sends no filter at all — the `None` filter, still valid.
        let empty: Filter = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.key_in, None);
    }

    #[test]
    fn invalid_input_yields_empty() {
        let index =
            Index::from_entries(vec![track("a", padded(&[1.0, 0.0]), TrackMeta::default())]);
        // empty probes
        assert!(search(&index, &req(vec![], 5)).matches.is_empty());
        // top_k zero
        assert!(search(&index, &req(vec![padded(&[1.0, 0.0])], 0))
            .matches
            .is_empty());
        // wrong-dimension probe
        assert!(search(&index, &req(vec![vec![1.0, 0.0]], 5))
            .matches
            .is_empty());
    }
}
