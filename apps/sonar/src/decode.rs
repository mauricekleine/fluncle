//! Little-endian f32 blob decoding.
//!
//! `embedding_blob` / `centroid_blob` cells are raw little-endian `f32` arrays —
//! exactly [`DIM`] floats = [`BLOB_LEN`] bytes. Anything else is rejected (the
//! caller logs + skips the row); decoding never panics.

/// Embedding dimensionality (MuQ). Every vector in either index is this long.
pub const DIM: usize = 1024;

/// Byte length of a well-formed blob: `DIM * size_of::<f32>()` = 4096.
pub const BLOB_LEN: usize = DIM * 4;

/// Decode a raw little-endian `f32` blob of exactly [`DIM`] floats.
///
/// Returns `None` (never panics) when `bytes.len() != BLOB_LEN`, so a corrupt or
/// truncated cell is skipped rather than crashing the load.
pub fn decode_le_f32(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() != BLOB_LEN {
        return None;
    }
    let mut out = Vec::with_capacity(DIM);
    for chunk in bytes.chunks_exact(4) {
        // chunks_exact(4) guarantees length 4, so this array build is total.
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hand-built 4096-byte little-endian blob decodes to the expected floats.
    #[test]
    fn decodes_known_little_endian_floats() {
        let mut bytes = Vec::with_capacity(BLOB_LEN);
        // First three floats are meaningful; the rest are zero padding to reach DIM.
        let known = [1.0_f32, -2.5_f32, 3.25_f32];
        for f in known {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
        bytes.resize(BLOB_LEN, 0);

        let decoded = decode_le_f32(&bytes).expect("well-formed blob decodes");
        assert_eq!(decoded.len(), DIM);
        assert_eq!(decoded[0], 1.0);
        assert_eq!(decoded[1], -2.5);
        assert_eq!(decoded[2], 3.25);
        assert_eq!(decoded[3], 0.0);
        assert_eq!(decoded[DIM - 1], 0.0);
    }

    /// Explicit byte-order check: 0x3F800000 little-endian == 1.0_f32.
    #[test]
    fn respects_little_endian_byte_order() {
        let mut bytes = vec![0x00, 0x00, 0x80, 0x3F]; // 1.0 LE
        bytes.resize(BLOB_LEN, 0);
        let decoded = decode_le_f32(&bytes).expect("decodes");
        assert_eq!(decoded[0], 1.0);
    }

    /// A blob whose length is not exactly BLOB_LEN is rejected (skipped, no panic).
    #[test]
    fn rejects_wrong_length_blob() {
        assert!(decode_le_f32(&[]).is_none());
        assert!(decode_le_f32(&[0u8; BLOB_LEN - 4]).is_none());
        assert!(decode_le_f32(&[0u8; BLOB_LEN + 4]).is_none());
        assert!(decode_le_f32(&[0u8; BLOB_LEN - 1]).is_none());
    }
}
