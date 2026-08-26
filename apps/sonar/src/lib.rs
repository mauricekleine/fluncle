//! `sonar` — Fluncle's in-memory exact vector-similarity engine.
//!
//! The heavy lifting (index, kernel, decode, search) lives here as a library so
//! it is unit-testable without a running server or a Turso connection. `main.rs`
//! is a thin wrapper: config, durable local bootstrap, the bounded consumer loop,
//! and the axum server.
//!
//! # Why exact, in-memory
//! Fluncle's vector corpus (~600MB, 1024-dim MuQ embeddings) is held entirely in
//! RAM and scanned brute-force with a rayon-parallel SIMD-friendly dot kernel.
//! At catalogue scale this is ~tens of ms single-probe with 100% recall — faster
//! and more accurate than a hosted `vector_distance_cos` SQL scan or an ANN index
//! with its recall loss. See `docs/the-ear.md` for the max-similarity-to-nearest
//! fold this implements (never a centroid/average of the probes).

pub mod artifact;
pub mod config;
pub mod consumer;
pub mod decode;
pub mod index;
pub mod kernel;
pub mod replica;
pub mod search;
pub mod server;
pub mod state;

pub use decode::{BLOB_LEN, DIM};
pub use index::{Entry, Index, IndexBuilder, TrackMeta};
pub use search::{Filter, IndexName, Match, SearchRequest, SearchResponse};
