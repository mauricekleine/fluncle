//! Synthetic scan bench — sanity-checks the single-probe / multi-probe latency
//! ballpark at 150k. NOT part of `cargo test` (a bin's main is not run by the
//! test harness). Run explicitly:
//!
//! ```sh
//! cargo run --release --bin bench
//! ```
//!
//! Env knobs: `SONAR_BENCH_N` (default 150000), `SONAR_BENCH_ITERS` (default 30),
//! `SONAR_BENCH_TOPK` (default 20), `SONAR_BENCH_PROBES` (default 12).

use std::time::Instant;

use sonar::decode::DIM;
use sonar::index::{Entry, Index};
use sonar::search::{search, IndexName, SearchRequest};

/// Tiny deterministic xorshift64 PRNG — avoids adding a `rand` dependency just
/// for synthetic vectors.
struct Xorshift(u64);
impl Xorshift {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /// A float in [-1.0, 1.0).
    fn next_f32(&mut self) -> f32 {
        let bits = (self.next_u64() >> 40) as f32; // 24 bits
        (bits / (1u32 << 23) as f32) - 1.0
    }
}

fn random_vec(rng: &mut Xorshift) -> Vec<f32> {
    (0..DIM).map(|_| rng.next_f32()).collect()
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn p50(mut durs: Vec<f64>) -> f64 {
    durs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    durs[durs.len() / 2]
}

fn bench(index: &Index, probes: Vec<Vec<f32>>, top_k: usize, iters: usize) -> f64 {
    let req = SearchRequest {
        index: IndexName::Tracks,
        probes,
        filter: None,
        exclude_ids: None,
        top_k,
    };
    // warm up
    let _ = search(index, &req);
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        let _ = search(index, &req);
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    p50(samples)
}

fn main() {
    let n = env_usize("SONAR_BENCH_N", 150_000);
    let iters = env_usize("SONAR_BENCH_ITERS", 30);
    let top_k = env_usize("SONAR_BENCH_TOPK", 20);
    let n_probes = env_usize("SONAR_BENCH_PROBES", 12);

    eprintln!("building synthetic index: n={n} dim={DIM} ...");
    let mut rng = Xorshift(0x9E3779B97F4A7C15);
    let build = Instant::now();
    let entries: Vec<Entry> = (0..n)
        .map(|i| Entry {
            id: format!("t{i}"),
            vector: random_vec(&mut rng),
            meta: None,
        })
        .collect();
    let index = Index::from_entries(entries);
    eprintln!(
        "built {} entries in {:.2}s",
        index.len(),
        build.elapsed().as_secs_f64()
    );

    let single = bench(&index, vec![random_vec(&mut rng)], top_k, iters);
    let multi_probes: Vec<Vec<f32>> = (0..n_probes).map(|_| random_vec(&mut rng)).collect();
    let multi = bench(&index, multi_probes, top_k, iters);

    let threads = rayon::current_num_threads();
    println!(
        "bench: n={n} dim={DIM} top_k={top_k} threads={threads} iters={iters} \
         single-probe_p50={single:.2}ms {n_probes}-probe_p50={multi:.2}ms"
    );
}
