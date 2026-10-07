//! `zm-harness` — regenerate the committed fixtures, print a corpus,
//! compare two rankers' answers to the labeled queries, or convert an
//! outside benchmark to the corpus shape.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use zeromem_harness::compare::{self, Ranked};
use zeromem_harness::corpus::{self, Profile};
use zeromem_harness::{fixtures, import};

#[derive(Parser)]
#[command(name = "zm-harness", about = "zeromem test harness: fixtures and metrics")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Regenerate every committed corpus under crates/zeromem-harness/fixtures/.
    Gen,
    /// Print one profile's turns (or queries) as JSONL on stdout.
    Show {
        /// `small` or `large`.
        profile: String,
        #[arg(long)]
        queries: bool,
        /// The history, as-of and unanswerable questions instead.
        #[arg(long, conflicts_with = "queries")]
        probes: bool,
    },
    /// Score two rankers' answers to a profile's labeled queries, against
    /// the labels and against each other. Each file holds one
    /// `{"id","ranked":[uuid,…]}` per line; `scripts/rank.sh` produces ours.
    Compare {
        /// `small` or `large`.
        profile: String,
        left: PathBuf,
        right: PathBuf,
        #[arg(long, default_value_t = 5)]
        k: usize,
        /// Print the full comparison as JSON instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Convert a benchmark file you downloaded into `turns.jsonl`,
    /// `queries.jsonl` and `probes.jsonl` under a directory of your own.
    /// The result is for a local run (`ZEROMEM_EVAL_CORPUS=<dir>`): nothing
    /// here is committed and no floor reads it.
    Import {
        /// The only format read today: `longmemeval`.
        format: String,
        file: PathBuf,
        /// Where to write; created if missing.
        #[arg(long)]
        out: PathBuf,
    },
}

fn profile(name: &str) -> Result<&'static Profile> {
    corpus::PROFILES
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| anyhow::anyhow!("no profile named {name}; try small or large"))
}

fn read_ranked(path: &PathBuf) -> Result<Vec<Ranked>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    fixtures::from_jsonl(&text).with_context(|| format!("parsing {}", path.display()))
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Gen => {
            for path in fixtures::write_all()? {
                eprintln!("wrote {}", path.display());
            }
        }
        Command::Show { profile: name, queries, probes } => {
            let corpus = corpus::generate(profile(&name)?);
            let (turns, qs, ps) = fixtures::render(&corpus)?;
            print!(
                "{}",
                if probes {
                    ps
                } else if queries {
                    qs
                } else {
                    turns
                }
            );
        }
        Command::Compare { profile: name, left, right, k, json } => {
            let corpus = fixtures::load(profile(&name)?)?;
            let (l, r) = (read_ranked(&left)?, read_ranked(&right)?);
            let c = compare::compare(&corpus.queries, &l, &r, k);
            if json {
                println!("{}", serde_json::to_string_pretty(&c)?);
            } else {
                println!("{} queries answered by both sides, k = {}\n", c.queries, c.k);
                println!("| side | recall@k | MRR | nDCG@k |");
                println!("| --- | ---: | ---: | ---: |");
                for (label, s) in [("left", &c.left), ("right", &c.right)] {
                    println!("| {label} | {:.3} | {:.3} | {:.3} |", s.recall_at_k, s.mrr, s.ndcg_at_k);
                }
                println!("\noverlap@k {:.3}", c.overlap_at_k);
                match c.spearman {
                    Some(rho) => println!("spearman {rho:.3} over {} queries sharing 2+ items", c.spearman_queries),
                    None => println!("spearman n/a: no query shares two items"),
                }
            }
        }
        Command::Import { format, file, out } => {
            if format != "longmemeval" {
                anyhow::bail!("no importer for {format}; try longmemeval");
            }
            let text = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
            let (corpus, report) =
                import::longmemeval(&text).with_context(|| format!("importing {}", file.display()))?;
            let (turns, queries, probes) = fixtures::render(&corpus)?;
            std::fs::create_dir_all(&out).with_context(|| format!("creating {}", out.display()))?;
            for (name, body) in [("turns.jsonl", turns), ("queries.jsonl", queries), ("probes.jsonl", probes)] {
                let path = out.join(name);
                std::fs::write(&path, body).with_context(|| format!("writing {}", path.display()))?;
            }
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
    }
    Ok(())
}
