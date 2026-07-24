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
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Filter {
    pub key_in: Option<Vec<String>>,
    pub bpm_min: Option<f32>,
    pub bpm_max: Option<f32>,
    pub anchored: Option<bool>,
    pub certified: Option<bool>,
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
