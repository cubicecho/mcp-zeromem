#!/usr/bin/env bash
# Answer a fixture profile's labeled queries with our `zm` and write one
# `{"id","ranked":[uuid,…]}` per line — the left-hand input of
# `zm-harness compare`. The right-hand side is whatever other ranker was run
# over the same turns (`crates/zeromem-harness/fixtures/<profile>/turns.jsonl`)
# and made to emit the same shape; see README "Comparing against upstream".
#
#   scripts/rank.sh [small|large] [k] > ours.jsonl
#
# Uses the hash embedder so the answer is deterministic and offline; set
# ZEROMEM_EMBEDDER=onnx for the model. Needs `cargo` and `jq`.
set -euo pipefail

cd "$(dirname "$0")/.."

profile=${1:-small}
k=${2:-5}
embedder=${ZEROMEM_EMBEDDER:-hash}
fixtures="crates/zeromem-harness/fixtures/$profile"
[ -f "$fixtures/turns.jsonl" ] || { echo "no fixtures for profile '$profile'" >&2; exit 1; }

cargo build -q --release -p zeromem-core --bin zm
zm=target/release/zm

home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

"$zm" --home "$home" --embedder "$embedder" ingest --file "$fixtures/turns.jsonl" > /dev/null

while IFS= read -r line; do
  id=$(jq -r .id <<< "$line")
  query=$(jq -r .query <<< "$line")
  "$zm" --home "$home" --embedder "$embedder" query --top-k "$k" "$query" \
    | jq -c --arg id "$id" '{id: $id, ranked: [.evidence[].turn.uuid]}'
done < "$fixtures/queries.jsonl"
