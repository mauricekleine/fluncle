//! The in-memory index: a flat, unit-normalized vector store plus per-entry
//! metadata. Vectors are stored contiguously (`n * DIM` f32s) so the scan kernel
//! walks memory linearly. Every vector is L2-normalized on build, so cosine
//! similarity reduces to a plain dot product in the kernel.

use crate::decode::DIM;

/// Per-track filterable metadata. Centroid entries carry `None` (no metadata).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrackMeta {
    pub key: Option<String>,
    pub bpm: Option<f32>,
    pub anchored: bool,
    pub certified: bool,
}

/// One entry to be loaded into an [`Index`]. `vector` is the raw (un-normalized)
/// 1024-dim embedding; [`Index::from_entries`] normalizes it.
pub struct Entry {
    pub id: String,
    pub vector: Vec<f32>,
    pub meta: Option<TrackMeta>,
}

/// L2-normalize a vector in place. A zero vector is left untouched (its dot with
/// anything is 0), avoiding a divide-by-zero.
pub fn normalize_in_place(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        let inv = 1.0 / norm;
        for x in v.iter_mut() {
            *x *= inv;
        }
    }
}

/// An immutable snapshot of one corpus (tracks or centroids). Built once, then
/// atomically hot-swapped behind an `ArcSwap` on refresh, so in-flight queries
/// always see a consistent snapshot.
pub struct Index {
    ids: Vec<String>,
    /// Flat storage: entry `i` occupies `vectors[i*DIM .. (i+1)*DIM]`, normalized.
    vectors: Vec<f32>,
    metas: Vec<Option<TrackMeta>>,
}

impl Index {
    /// Build an index from entries. Each vector is normalized on the way in.
    /// Entries whose vector length != [`DIM`] are skipped defensively (the decode
    /// layer already guards this, but a direct caller might not).
    pub fn from_entries(entries: Vec<Entry>) -> Self {
        let n = entries.len();
        let mut ids = Vec::with_capacity(n);
        let mut vectors = Vec::with_capacity(n * DIM);
        let mut metas = Vec::with_capacity(n);
        for entry in entries {
            if entry.vector.len() != DIM {
                continue;
            }
            let mut v = entry.vector;
            normalize_in_place(&mut v);
            ids.push(entry.id);
            vectors.extend_from_slice(&v);
            metas.push(entry.meta);
        }
        Self {
            ids,
            vectors,
            metas,
        }
    }

    /// An empty index (used as the never-null starting point before first load
    /// is not needed — we fail fast on initial load — but handy in tests).
    pub fn empty() -> Self {
        Self {
            ids: Vec::new(),
            vectors: Vec::new(),
            metas: Vec::new(),
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// The normalized vector for entry `i` (`i < len`).
    #[inline]
    pub fn vector_at(&self, i: usize) -> &[f32] {
        &self.vectors[i * DIM..(i + 1) * DIM]
    }

    #[inline]
    pub fn id_at(&self, i: usize) -> &str {
        &self.ids[i]
    }

    #[inline]
    pub fn meta_at(&self, i: usize) -> Option<&TrackMeta> {
        self.metas[i].as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_to_unit_length() {
        let mut v = vec![3.0, 4.0];
        v.resize(DIM, 0.0);
        normalize_in_place(&mut v);
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
        assert!((v[0] - 0.6).abs() < 1e-6);
        assert!((v[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn zero_vector_is_left_alone() {
        let mut v = vec![0.0_f32; DIM];
        normalize_in_place(&mut v);
        assert!(v.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn skips_wrong_length_entries() {
        let good = Entry {
            id: "a".into(),
            vector: vec![1.0; DIM],
            meta: None,
        };
        let bad = Entry {
            id: "b".into(),
            vector: vec![1.0; DIM - 1],
            meta: None,
        };
        let idx = Index::from_entries(vec![good, bad]);
        assert_eq!(idx.len(), 1);
        assert_eq!(idx.id_at(0), "a");
    }
}
