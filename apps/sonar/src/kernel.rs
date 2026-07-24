//! The performance core: a rayon-parallel single-pass scan.
//!
//! The scan walks the candidate set once. For each candidate it computes
//! `max over probes of dot(probe, vector)` — the max-similarity-to-nearest-probe
//! fold (a single probe is just that one dot). This is the multi-probe min-fold
//! from `docs/the-ear.md`: it is NEVER a centroid/average of the probes. Each
//! rayon worker maintains its own bounded top-K heap; the heaps are merged at the
//! end. The `dot` over 1024 contiguous f32s is a tight loop the compiler
//! autovectorizes to SIMD at opt-level 3.

use std::cmp::Ordering;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

use rayon::prelude::*;

use crate::index::Index;

/// Cosine similarity of two already-normalized vectors == their dot product.
/// Both slices are expected to be [`crate::decode::DIM`] long; the zip walks the
/// shorter, which upstream guarantees to be equal.
#[inline]
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut sum = 0.0_f32;
    for (x, y) in a.iter().zip(b.iter()) {
        sum += x * y;
    }
    sum
}

/// `max over probes of dot(probe, vec)` — similarity to the NEAREST probe.
/// Returns `f32::NEG_INFINITY` for an empty probe set (callers guard against it).
#[inline]
pub fn max_over_probes(probes: &[Vec<f32>], vec: &[f32]) -> f32 {
    let mut best = f32::NEG_INFINITY;
    for p in probes {
        let s = dot(p, vec);
        if s > best {
            best = s;
        }
    }
    best
}

/// A scored index, ordered by score with a total order over f32 (NaN-safe) so it
/// can live in a `BinaryHeap`.
#[derive(Clone, Copy)]
struct Scored {
    score: f32,
    idx: usize,
}

impl PartialEq for Scored {
    fn eq(&self, other: &Self) -> bool {
        self.score.total_cmp(&other.score) == Ordering::Equal
    }
}
impl Eq for Scored {}
impl PartialOrd for Scored {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Scored {
    fn cmp(&self, other: &Self) -> Ordering {
        self.score.total_cmp(&other.score)
    }
}

/// A bounded top-K collector: a min-heap of size `k` keeping the k highest scores
/// seen. `Reverse` makes the `BinaryHeap` (a max-heap) behave as a min-heap so the
/// smallest kept score is at the top and cheap to evict.
struct BoundedTopK {
    k: usize,
    heap: BinaryHeap<Reverse<Scored>>,
}

impl BoundedTopK {
    fn new(k: usize) -> Self {
        Self {
            k,
            heap: BinaryHeap::with_capacity(k.saturating_add(1)),
        }
    }

    #[inline]
    fn push(&mut self, idx: usize, score: f32) {
        if self.k == 0 {
            return;
        }
        if self.heap.len() < self.k {
            self.heap.push(Reverse(Scored { score, idx }));
        } else if let Some(Reverse(min)) = self.heap.peek() {
            if score > min.score {
                self.heap.pop();
                self.heap.push(Reverse(Scored { score, idx }));
            }
        }
    }

    fn merge(&mut self, other: BoundedTopK) {
        for Reverse(s) in other.heap {
            self.push(s.idx, s.score);
        }
    }

    /// Drain into `(idx, score)` pairs sorted by score descending (nearest first).
    fn into_sorted_desc(self) -> Vec<(usize, f32)> {
        let mut v: Vec<Scored> = self.heap.into_iter().map(|r| r.0).collect();
        v.sort_by(|a, b| b.score.total_cmp(&a.score));
        v.into_iter().map(|s| (s.idx, s.score)).collect()
    }
}

/// Single-pass parallel scan over `0..index.len()`. `keep(i)` is the candidate
/// predicate (metadata filter + exclude set); only kept entries are scored. Runs
/// on the rayon pool — a per-worker bounded top-K, merged at the end.
///
/// Returns up to `top_k` `(entry_index, score)` pairs, score descending.
pub fn scan<F>(index: &Index, probes: &[Vec<f32>], top_k: usize, keep: F) -> Vec<(usize, f32)>
where
    F: Fn(usize) -> bool + Sync,
{
    if top_k == 0 || probes.is_empty() || index.is_empty() {
        return Vec::new();
    }
    (0..index.len())
        .into_par_iter()
        .fold(
            || BoundedTopK::new(top_k),
            |mut acc, i| {
                if keep(i) {
                    let score = max_over_probes(probes, index.vector_at(i));
                    acc.push(i, score);
                }
                acc
            },
        )
        .reduce(
            || BoundedTopK::new(top_k),
            |mut a, b| {
                a.merge(b);
                a
            },
        )
        .into_sorted_desc()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::DIM;

    fn padded(values: &[f32]) -> Vec<f32> {
        let mut v = values.to_vec();
        v.resize(DIM, 0.0);
        v
    }

    #[test]
    fn dot_of_known_vectors() {
        let a = padded(&[1.0, 2.0, 3.0]);
        let b = padded(&[4.0, -5.0, 6.0]);
        // 1*4 + 2*-5 + 3*6 = 4 - 10 + 18 = 12
        assert!((dot(&a, &b) - 12.0).abs() < 1e-6);
    }

    #[test]
    fn dot_of_orthogonal_is_zero() {
        let a = padded(&[1.0, 0.0]);
        let b = padded(&[0.0, 1.0]);
        assert!(dot(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn max_over_single_probe_is_that_dot() {
        let probe = padded(&[1.0, 0.0]);
        let v = padded(&[0.5, 0.5]);
        let expected = dot(&probe, &v);
        assert!((max_over_probes(&[probe], &v) - expected).abs() < 1e-6);
    }

    /// The fold is max-similarity-to-NEAREST — a candidate that matches one probe
    /// perfectly wins even if it is far (orthogonal) from the other probe. A
    /// centroid/average of the probes would score it lower; assert it does not.
    #[test]
    fn max_over_probes_is_nearest_not_centroid() {
        let p1 = padded(&[1.0, 0.0]); // unit x
        let p2 = padded(&[0.0, 1.0]); // unit y (orthogonal)
        let probes = vec![p1.clone(), p2.clone()];

        // Candidate identical to p1: perfect match to one probe, orthogonal to other.
        let on_probe = padded(&[1.0, 0.0]);
        // Candidate on the centroid direction of p1+p2 (45°), closer "on average".
        let mut on_centroid = padded(&[1.0, 1.0]);
        crate::index::normalize_in_place(&mut on_centroid);

        let nearest_score = max_over_probes(&probes, &on_probe);
        let centroid_score = max_over_probes(&probes, &on_centroid);

        // Nearest-probe candidate scores ~1.0 (a full match to p1).
        assert!((nearest_score - 1.0).abs() < 1e-6);
        // Centroid candidate's best single-probe dot is ~0.707 (1/sqrt(2)),
        // strictly lower — proving we take the max over probes, not the centroid.
        assert!((centroid_score - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-5);
        assert!(nearest_score > centroid_score);
    }

    #[test]
    fn bounded_topk_keeps_highest_in_order() {
        let mut h = BoundedTopK::new(2);
        h.push(0, 0.1);
        h.push(1, 0.9);
        h.push(2, 0.5);
        h.push(3, 0.3);
        let out = h.into_sorted_desc();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, 1); // 0.9 first
        assert_eq!(out[1].0, 2); // 0.5 second
    }
}
