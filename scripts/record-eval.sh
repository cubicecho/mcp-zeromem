#!/usr/bin/env bash
# Run the eval harness and append its numbers to docs/eval/history.jsonl.
#
#   scripts/record-eval.sh [label]
#
# Runs the `eval` test in crates/zeromem-core (which writes one JSON file per
# profile × embedder to target/eval/) and appends one history line per file,
# stamped with the commit and the time. Needs the ONNX model for the
# bge-small rows; set ZEROMEM_MODELS to a cache to avoid re-downloading it.
# Set ZEROMEM_SKIP_ONNX=1 to record the hash rows only. With
# ZEROMEM_EMBEDDING_URL and ZEROMEM_EMBEDDING_MODEL set, an OpenAI-compatible
# endpoint is scored as well and recorded under its own embedder name.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
label="${1:-}"
history="$root/docs/eval/history.jsonl"
commit="${GIT_COMMIT:-$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

command -v jq >/dev/null || { echo "record-eval: jq is required" >&2; exit 1; }

rm -f "$root"/target/eval/*-*.json
(cd "$root" && cargo test -p zeromem-core --test eval -- --nocapture >/dev/null)

mkdir -p "$(dirname "$history")"
appended=0
for f in "$root"/target/eval/*-*.json; do
  [ -f "$f" ] || continue
  jq -c --arg recorded_at "$recorded_at" --arg commit "$commit" --arg label "$label" '{
    recorded_at: $recorded_at,
    commit: $commit,
    label: (if $label == "" then null else $label end),
    profile: .profile,
    embedder: .embedder,
    k: .summary.k,
    queries: .summary.queries,
    recall_at_k: .summary.recall_at_k,
    mrr: .summary.mrr,
    ndcg_at_k: .summary.ndcg_at_k,
    missed: (.missed | length)
  } | with_entries(select(.value != null))' "$f" >> "$history"
  appended=$((appended + 1))
done

echo "record-eval: appended $appended run(s) at $commit to ${history#"$root"/}"
