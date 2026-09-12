//! `zm` — the command-line face of the engine.
//!
//! Everything prints JSON on stdout so it composes with the test harness and
//! with scripts; diagnostics go to stderr. The store is located by
//! `ZEROMEM_HOME` (see `zeromem_core::home`), overridable with `--home`.

use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use zeromem_core::dense::{EmbedderChoice, EmbedderSpec, RemoteSpec};
use zeromem_core::{home, Detail, OpenOptions, QueryOptions, TurnInput, ZeroMem};

mod transcript;

#[derive(Parser)]
#[command(name = "zm", version, about = "zeromem: zero-token conversational memory")]
struct Cli {
    /// Store directory. Defaults to $ZEROMEM_HOME, then $HOME/.zeromem.
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    /// Which embedder to ask for. A store records its own embedder and an
    /// existing store is followed whatever this says; `auto` on a fresh
    /// store loads the ONNX model, downloading it on first use, and falls
    /// back to hashing loudly. Reads `ZEROMEM_EMBEDDER` so a hook and the
    /// server agree without flags.
    #[arg(long, global = true, value_enum, env = "ZEROMEM_EMBEDDER", default_value_t = EmbedderArg::Auto)]
    embedder: EmbedderArg,
    /// Allow opening a store built by a different embedder; every vector is
    /// dropped and re-made.
    #[arg(long, global = true, env = "ZEROMEM_ALLOW_EMBEDDER_SWITCH", value_parser = clap::builder::BoolishValueParser::new(), default_value_t = false)]
    allow_embedder_switch: bool,
    #[command(flatten)]
    remote: RemoteArgs,
    #[command(subcommand)]
    command: Command,
}

/// The endpoint `--embedder openai` refers to, from the same environment
/// the server reads. `zm embedder set|test` take their own flags and fall
/// back to these.
#[derive(Args, Clone)]
struct RemoteArgs {
    /// Base URL of an OpenAI-compatible endpoint, up to `/v1`.
    #[arg(long = "embedding-url", global = true, env = "ZEROMEM_EMBEDDING_URL", value_name = "URL")]
    url: Option<String>,
    #[arg(long = "embedding-model", global = true, env = "ZEROMEM_EMBEDDING_MODEL", value_name = "MODEL")]
    model: Option<String>,
    /// Sent as a bearer token; overrides the key stored in the store.
    #[arg(
        long = "embedding-api-key",
        global = true,
        env = "ZEROMEM_EMBEDDING_API_KEY",
        hide_env_values = true,
        value_name = "KEY"
    )]
    api_key: Option<String>,
    #[arg(long = "embedding-query-prefix", global = true, env = "ZEROMEM_EMBEDDING_QUERY_PREFIX", value_name = "TEXT")]
    query_prefix: Option<String>,
    #[arg(
        long = "embedding-document-prefix",
        global = true,
        env = "ZEROMEM_EMBEDDING_DOCUMENT_PREFIX",
        value_name = "TEXT"
    )]
    document_prefix: Option<String>,
    #[arg(long = "embedding-timeout-ms", global = true, env = "ZEROMEM_EMBEDDING_TIMEOUT_MS", value_name = "MS")]
    timeout_ms: Option<u64>,
}

impl RemoteArgs {
    fn spec(&self) -> Result<RemoteSpec> {
        let url = self
            .url
            .clone()
            .filter(|u| !u.trim().is_empty())
            .context("an openai embedder needs --embedding-url (ZEROMEM_EMBEDDING_URL)")?;
        let model = self
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .context("an openai embedder needs --embedding-model (ZEROMEM_EMBEDDING_MODEL)")?;
        Ok(RemoteSpec {
            url,
            model,
            query_prefix: self.query_prefix.clone().unwrap_or_default(),
            document_prefix: self.document_prefix.clone().unwrap_or_default(),
            timeout_ms: self.timeout_ms.unwrap_or(zeromem_core::dense::remote::DEFAULT_TIMEOUT_MS),
            ..RemoteSpec::default()
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum EmbedderArg {
    Auto,
    Onnx,
    Hash,
    Openai,
    None,
}

impl From<EmbedderArg> for EmbedderChoice {
    fn from(a: EmbedderArg) -> Self {
        match a {
            EmbedderArg::Auto => EmbedderChoice::Auto,
            EmbedderArg::Onnx => EmbedderChoice::Onnx,
            EmbedderArg::Hash => EmbedderChoice::Hash,
            EmbedderArg::Openai => EmbedderChoice::OpenAi,
            EmbedderArg::None => EmbedderChoice::None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum SpecKind {
    Onnx,
    Hash,
    Openai,
}

/// Flags that describe an embedder to `zm embedder set|test`.
#[derive(Args, Clone)]
struct SpecArgs {
    #[arg(long, value_enum)]
    kind: SpecKind,
    /// Base URL up to `/v1`; falls back to --embedding-url.
    #[arg(long)]
    url: Option<String>,
    /// Falls back to --embedding-model.
    #[arg(long)]
    model: Option<String>,
    /// Read the API key from stdin (first line) and store it in the store.
    #[arg(long)]
    api_key_stdin: bool,
    #[arg(long)]
    query_prefix: Option<String>,
    #[arg(long)]
    document_prefix: Option<String>,
    #[arg(long)]
    timeout_ms: Option<u64>,
    /// Keep the key already stored for this endpoint when none is given.
    #[arg(long)]
    keep_key: bool,
}

impl SpecArgs {
    fn spec(&self, globals: &RemoteArgs) -> Result<EmbedderSpec> {
        Ok(match self.kind {
            SpecKind::Onnx => EmbedderSpec::Onnx,
            SpecKind::Hash => EmbedderSpec::Hash,
            SpecKind::Openai => {
                let merged = RemoteArgs {
                    url: self.url.clone().or_else(|| globals.url.clone()),
                    model: self.model.clone().or_else(|| globals.model.clone()),
                    api_key: None,
                    query_prefix: self.query_prefix.clone().or_else(|| globals.query_prefix.clone()),
                    document_prefix: self.document_prefix.clone().or_else(|| globals.document_prefix.clone()),
                    timeout_ms: self.timeout_ms.or(globals.timeout_ms),
                };
                let mut spec = merged.spec()?;
                if self.api_key_stdin {
                    let mut line = String::new();
                    io::stdin().lock().read_line(&mut line)?;
                    let key = line.trim().to_string();
                    if key.is_empty() {
                        bail!("--api-key-stdin: no key on stdin");
                    }
                    spec.api_key = Some(key);
                }
                EmbedderSpec::Remote(spec)
            }
        })
    }
}

#[derive(Subcommand)]
enum EmbedderCommand {
    /// The store's embedder, what this process can do with it, and the backlog.
    Show,
    /// Change the store's embedder. The new one is probed first; on success
    /// every vector is dropped and re-made by `drain` or by the server.
    Set(SpecArgs),
    /// Build an embedder and run one text through it; changes nothing.
    Test(SpecArgs),
    /// Drop every vector and re-make them with the store's embedder, which
    /// is probed first. Follow with `drain`, or let the server do it.
    Reembed,
    /// Embed every turn that has no vector yet.
    Drain {
        /// Turns per round; a line of progress is printed per round.
        #[arg(long, default_value_t = 256)]
        batch: usize,
    },
}

#[derive(Subcommand)]
enum Command {
    /// Counts for the store.
    Stats,
    /// Recall: what does the store know that bears on this?
    Query {
        query: String,
        #[arg(long, default_value_t = 5)]
        top_k: u32,
        /// Leave out this session.
        #[arg(long)]
        exclude_session: Option<String>,
        /// Only this session.
        #[arg(long)]
        session: Option<String>,
        /// Only turns at or after this timestamp (ms).
        #[arg(long)]
        since: Option<i64>,
        /// Only turns at or before this timestamp (ms).
        #[arg(long)]
        until: Option<i64>,
        /// Include the route and each item's provenance.
        #[arg(long)]
        full: bool,
        /// Print every stage of the run instead of the result.
        #[arg(long)]
        trace: bool,
        /// Recall turns a curator hid, too.
        #[arg(long)]
        include_hidden: bool,
        /// Attach this many same-session turns either side of each hit, so
        /// an answer arrives with its question and its continuation.
        #[arg(long, default_value_t = 0)]
        context: u32,
    },
    /// Recompute every derived index from the turns. Embeddings are kept.
    Rebuild,
    /// Claude Code hook: read `{"transcript_path","session_id"}` from stdin
    /// and remember the transcript's user and assistant turns.
    Hook {
        /// Rewrite a transcript path prefix, `HOST=HERE`, for when the hook
        /// runs inside a container that mounts the host's transcripts
        /// elsewhere (e.g. `/home/me/.claude=/host-claude`). Also read from
        /// ZEROMEM_HOOK_MAP.
        #[arg(long, env = "ZEROMEM_HOOK_MAP", value_name = "HOST=HERE")]
        map: Option<String>,
    },
    /// Read turns as JSON Lines ({session_id, speaker, text, ts?, uuid?}) from a file or stdin.
    Ingest {
        /// File to read; stdin when omitted.
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// List sessions, most recently active first.
    Sessions {
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Read one conversation in order: the whole session, or a window around
    /// one turn (the `id` a recall hit carries).
    Session {
        /// The session to read; optional when --around-turn names a turn.
        session_id: Option<String>,
        /// Centre the window on this turn id.
        #[arg(long)]
        around_turn: Option<i64>,
        /// With --around-turn: turns before it. Default 5.
        #[arg(long)]
        before: Option<u32>,
        /// With --around-turn: turns after it. Default 5.
        #[arg(long)]
        after: Option<u32>,
        /// Without --around-turn: how many turns. Default 50, capped at 200.
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        offset: Option<u32>,
    },
    /// Delete every turn of one session.
    Forget { session_id: String },
    /// Dump the whole store in canonical order (for the test harness).
    Snapshot,
    /// Show, test, change or drain the store's embedder.
    Embedder {
        #[command(subcommand)]
        action: EmbedderCommand,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("zm: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let cli = Cli::parse();
    let home = match cli.home {
        Some(h) => h,
        None => home::resolve_home()?,
    };
    let remote = match cli.embedder {
        EmbedderArg::Openai => Some(cli.remote.spec()?),
        _ => None,
    };
    // Only the embedder subcommands talk to a remote endpoint from this
    // process; a hook or a read leaves a remote store's embedding to the
    // server, so a host never blocks on the network.
    let follow_remote = matches!(cli.command, Command::Embedder { .. });
    let opts = OpenOptions {
        embedder: cli.embedder.into(),
        allow_embedder_switch: cli.allow_embedder_switch,
        remote,
        api_key: cli.remote.api_key.clone(),
        follow_remote,
    };
    let mut zm = ZeroMem::open(&home, opts).with_context(|| format!("opening store at {}", home.display()))?;

    match cli.command {
        Command::Stats => emit(&zm.stats()?)?,
        Command::Query {
            query,
            top_k,
            exclude_session,
            session,
            since,
            until,
            full,
            trace,
            include_hidden,
            context,
        } => {
            let opts = QueryOptions {
                top_k: Some(top_k),
                exclude_session,
                session,
                since,
                until,
                detail: Some(if full || trace { Detail::Full } else { Detail::Compact }),
                include_hidden: include_hidden.then_some(true),
                context: (context > 0).then_some(context),
            };
            if trace {
                emit(&zm.query_trace(&query, &opts)?)?;
            } else {
                emit(&zm.query(&query, &opts)?)?;
            }
        }
        Command::Rebuild => {
            zm.rebuild()?;
            emit(&zm.stats()?)?;
        }
        Command::Hook { map } => {
            let mut input = String::new();
            io::stdin().lock().read_to_string(&mut input)?;
            let event: serde_json::Value = serde_json::from_str(&input).context("hook input is not JSON")?;
            let Some(path) = event.get("transcript_path").and_then(|v| v.as_str()) else {
                bail!("hook input has no transcript_path");
            };
            let path = &map_path(path, map.as_deref())?;
            let session_id = event
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| PathBuf::from(path).file_stem().map(|s| s.to_string_lossy().into_owned()))
                .context("hook input has no session_id")?;
            let jsonl = std::fs::read_to_string(path).with_context(|| format!("reading transcript {path}"))?;
            let turns = transcript::parse(&session_id, &jsonl);
            let report = zm.ingest_many(&turns)?;
            emit(&serde_json::json!({ "session_id": session_id, "parsed": turns.len(), "report": report }))?;
        }
        Command::Ingest { file } => {
            let turns = read_turns(file)?;
            emit(&zm.ingest_many(&turns)?)?;
        }
        Command::Sessions { limit, offset } => emit(&zm.list_sessions(limit, offset)?)?,
        Command::Session { session_id, around_turn, before, after, limit, offset } => {
            let opts = zeromem_core::SessionWindowOptions { session_id, around_turn, before, after, limit, offset };
            emit(&zm.session_window(&opts)?)?;
        }
        Command::Forget { session_id } => {
            let removed = zm.delete_session(&session_id)?;
            emit(&serde_json::json!({ "session_id": session_id, "removed": removed }))?;
        }
        Command::Snapshot => emit(&zm.snapshot()?)?,
        Command::Embedder { action } => match action {
            EmbedderCommand::Show => emit(&zm.embedder_settings()?)?,
            EmbedderCommand::Test(args) => emit(&zm.probe_embedder(args.spec(&cli.remote)?, args.keep_key)?)?,
            EmbedderCommand::Set(args) => {
                let spec = args.spec(&cli.remote)?;
                let report = zm.set_embedder(spec, args.keep_key)?;
                if report.turns_to_embed > 0 {
                    eprintln!(
                        "zm: {} turns to re-embed; run `zm embedder drain` or let the server do it",
                        report.turns_to_embed
                    );
                }
                emit(&report)?;
            }
            EmbedderCommand::Reembed => {
                let report = zm.reembed()?;
                eprintln!(
                    "zm: {} turns to re-embed; run `zm embedder drain` or let the server do it",
                    report.turns_to_embed
                );
                emit(&report)?;
            }
            EmbedderCommand::Drain { batch } => {
                let batch = batch.max(1);
                let mut done = 0u64;
                let settings = zm.embedder_settings()?;
                if !settings.active {
                    bail!(
                        "{}",
                        settings.embedder_warning.unwrap_or_else(|| "this store has no embedder to drain with".into())
                    );
                }
                loop {
                    let before = zm.embedding_backlog()?;
                    let left = zm.embed_backlog(batch)?;
                    done += before.saturating_sub(left);
                    eprintln!("zm: embedded {done}, {left} to go");
                    if left == 0 || before == left {
                        break;
                    }
                }
                emit(&zm.stats()?)?;
            }
        },
    }
    Ok(())
}

/// Apply a `HOST=HERE` prefix rewrite to a transcript path.
fn map_path(path: &str, map: Option<&str>) -> Result<String> {
    let Some(map) = map.filter(|m| !m.is_empty()) else {
        return Ok(path.to_string());
    };
    let (from, to) = map.split_once('=').context("--map takes HOST=HERE")?;
    match path.strip_prefix(from) {
        Some(rest) => Ok(format!("{to}{rest}")),
        None => Ok(path.to_string()),
    }
}

fn read_turns(file: Option<PathBuf>) -> Result<Vec<TurnInput>> {
    let mut text = String::new();
    match file {
        Some(path) => {
            std::fs::File::open(&path)
                .with_context(|| format!("reading {}", path.display()))?
                .read_to_string(&mut text)?;
        }
        None => {
            io::stdin().lock().read_to_string(&mut text)?;
        }
    }
    let mut turns = Vec::new();
    for (n, line) in text.as_bytes().lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let turn: TurnInput = serde_json::from_str(&line).with_context(|| format!("line {}: not a turn", n + 1))?;
        turns.push(turn);
    }
    Ok(turns)
}

fn emit<T: serde::Serialize>(value: &T) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, value)?;
    out.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::map_path;

    #[test]
    fn map_path_rewrites_only_the_matching_prefix() {
        let map = Some("/home/me/.claude=/host-claude");
        assert_eq!(map_path("/home/me/.claude/projects/x/s.jsonl", map).unwrap(), "/host-claude/projects/x/s.jsonl");
        assert_eq!(map_path("/elsewhere/s.jsonl", map).unwrap(), "/elsewhere/s.jsonl");
        assert_eq!(map_path("/elsewhere/s.jsonl", None).unwrap(), "/elsewhere/s.jsonl");
        assert_eq!(map_path("/elsewhere/s.jsonl", Some("")).unwrap(), "/elsewhere/s.jsonl");
        assert!(map_path("/x", Some("no-equals")).is_err());
    }
}
