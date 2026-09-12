//! Cold-open time, resident memory and recall latency at 1k / 10k / 50k turns.
//!
//! The one number the design was built around is cold open: every derived
//! index is persisted, so opening a store should cost a schema check and one
//! read of the vectors, not a re-derivation of everything from the turns. This
//! measures that, on a generated corpus, with the hash embedder so the run is
//! about the store and not about the model.
//!
//! ```text
//! cargo run --release -p zeromem-core --example bench -- [--sizes 1000,10000,50000] [--out target/bench]
//! ```
//!
//! Writes one JSON per size under `--out` and prints a Markdown table; CI
//! keeps the JSON as an artifact so the numbers are tracked, not remembered.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use zeromem_core::dense::EmbedderChoice;
use zeromem_core::{OpenOptions, QueryOptions, TurnInput, ZeroMem};
use zeromem_harness::corpus::{self, Profile, Register};

#[derive(Serialize)]
struct Report {
    turns: usize,
    sessions: usize,
    embedder: &'static str,
    ingest_ms: u128,
    ingest_turns_per_s: f64,
    cold_open_ms: u128,
    rss_after_open_mb: f64,
    query_p50_ms: f64,
    query_p95_ms: f64,
    store_bytes: u64,
}

fn main() -> anyhow::Result<()> {
    let mut sizes = vec![1_000usize, 10_000, 50_000];
    let mut out = PathBuf::from("target/bench");
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--sizes" => {
                sizes = args.next().unwrap_or_default().split(',').filter_map(|s| s.trim().parse().ok()).collect();
            }
            "--out" => out = PathBuf::from(args.next().unwrap_or_default()),
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    std::fs::create_dir_all(&out)?;

    println!("| turns | sessions | ingest | turns/s | cold open | RSS | recall p50 | recall p95 | store |");
    println!("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for size in sizes {
        let report = run(size)?;
        println!(
            "| {} | {} | {} ms | {:.0} | {} ms | {:.0} MB | {:.2} ms | {:.2} ms | {:.1} MB |",
            report.turns,
            report.sessions,
            report.ingest_ms,
            report.ingest_turns_per_s,
            report.cold_open_ms,
            report.rss_after_open_mb,
            report.query_p50_ms,
            report.query_p95_ms,
            report.store_bytes as f64 / 1e6
        );
        std::fs::write(out.join(format!("{size}.json")), serde_json::to_string_pretty(&report)?)?;
    }
    Ok(())
}

fn run(target_turns: usize) -> anyhow::Result<Report> {
    // The large fixture averages ~15 turns per session; size the profile to land near the target.
    let sessions = (target_turns / 15).max(1);
    let profile = Profile {
        name: "bench",
        seed: 0xBE7C_0000 + target_turns as u64,
        sessions,
        facts_per_session: (3, 7),
        // The bench measures latency, not ranking, so it keeps the
        // prose register the numbers in README were taken with.
        register: Register::Prose,
    };
    let generated = corpus::generate(&profile);
    let turns: Vec<TurnInput> = generated
        .turns
        .iter()
        .take(target_turns)
        .map(|t| TurnInput {
            session_id: t.session_id.clone(),
            speaker: t.speaker.clone(),
            text: t.text.clone(),
            ts: Some(t.ts),
            uuid: Some(t.uuid.clone()),
        })
        .collect();
    let queries: Vec<&str> = generated.queries.iter().map(|q| q.query.as_str()).take(100).collect();

    let dir = tempfile::tempdir()?;
    let opts = || OpenOptions { embedder: EmbedderChoice::Hash, ..OpenOptions::default() };

    let ingest_ms = {
        let mut zm = ZeroMem::open(dir.path(), opts())?;
        let start = Instant::now();
        for chunk in turns.chunks(1000) {
            zm.ingest_many(chunk)?;
        }
        start.elapsed().as_millis()
    };

    let start = Instant::now();
    let mut zm = ZeroMem::open(dir.path(), opts())?;
    let stats = zm.stats()?;
    let cold_open_ms = start.elapsed().as_millis();
    anyhow::ensure!(stats.turns as usize == turns.len(), "store holds {} turns, ingested {}", stats.turns, turns.len());

    let mut latencies: Vec<Duration> = Vec::with_capacity(queries.len());
    for q in &queries {
        let start = Instant::now();
        zm.query(q, &QueryOptions::default())?;
        latencies.push(start.elapsed());
    }
    latencies.sort();
    let pct = |p: f64| latencies[((latencies.len() as f64 - 1.0) * p).round() as usize].as_secs_f64() * 1e3;

    let store_bytes = std::fs::read_dir(dir.path())?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum();

    Ok(Report {
        turns: turns.len(),
        sessions: stats.sessions as usize,
        embedder: "hash-384",
        ingest_ms,
        ingest_turns_per_s: turns.len() as f64 / (ingest_ms.max(1) as f64 / 1e3),
        cold_open_ms,
        rss_after_open_mb: rss_bytes().map(|b| b as f64 / 1e6).unwrap_or(f64::NAN),
        query_p50_ms: pct(0.5),
        query_p95_ms: pct(0.95),
        store_bytes,
    })
}

/// Resident set size from procfs; `None` where there is no procfs.
fn rss_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}
