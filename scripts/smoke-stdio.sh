#!/usr/bin/env bash
# Pipe a JSON-RPC session — initialize → tools/list → remember → recall —
# into the stdio MCP entry point and assert the answers, then a second
# session against the same store to check the turns persisted. Run after
# `npm run build`; the store is a temp directory that is removed afterwards.
# The hash embedder keeps it offline.
#
# Requests piped in at once are handled concurrently, so a session's calls
# are ordered by dependency (recall after remember holds because the engine
# serialises them; a stats call in the same batch might not).
set -euo pipefail

cd "$(dirname "$0")/.."

home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

session=$(cat <<'JSON'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"zeromem_remember","arguments":{"session_id":"smoke","turns":[{"speaker":"user","text":"Maya Okafor owns the billing service on Project Heron."},{"speaker":"assistant","text":"Noted: Maya owns billing."}]}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"zeromem_recall","arguments":{"query":"who owns the billing service?","top_k":3}}}
JSON
)

run() { DATA_DIR="$home" ZEROMEM_EMBEDDER=hash node server/dist/stdio.js 2>/dev/null; }
out=$(printf '%s\n' "$session" | run)

fail() { echo "$1"; echo "$out"; exit 1; }

echo "$out" | grep -q '"serverInfo":{"name":"mcp-zeromem"' || fail 'initialize: wrong server info'
for tool in zeromem_recall zeromem_remember zeromem_ingest zeromem_stats zeromem_forget_session; do
  echo "$out" | grep -q "\"name\":\"$tool\"" || fail "tools/list: $tool missing"
done
echo "$out" | grep -q '\\"indexed\\": 2' || fail 'zeromem_remember: expected 2 indexed'
echo "$out" | grep -q 'Maya Okafor owns the billing service' || fail 'zeromem_recall: the remembered turn did not come back'

again=$(cat <<'JSON'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zeromem_stats","arguments":{}}}
JSON
)
out=$(printf '%s\n' "$again" | run)
echo "$out" | grep -q '\\"turns\\": 2' || fail 'zeromem_stats: the turns did not persist across processes'

echo 'stdio smoke: ok'
