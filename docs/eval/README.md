# Eval history

`history.jsonl` holds one line per harness run: a profile (`small`, `large`), an
embedder, and the recall@k / MRR / nDCG@k the labeled queries scored, stamped with
the commit and the time. The admin UI's Eval page charts it, so ranking quality is
visible across commits rather than only asserted by the floors in
`crates/zeromem-core/tests/eval.rs`.

Append to it with `scripts/record-eval.sh [label]` after a retrieval change and
commit the result together with the change. Lines are appended, never rewritten;
a malformed line is skipped by the reader.
