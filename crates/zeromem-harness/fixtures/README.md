# Generated fixtures

Do not edit these by hand. They are the output of the generator in
`../src/corpus.rs` for the profiles it defines, and `fixtures_are_fresh` in that
crate fails when the committed bytes and the generator disagree. To change a
corpus, change the generator, then:

```bash
npm run fixtures:gen      # or: cargo run -p zeromem-harness -- gen
```

and commit the result. Each profile directory holds:

- `turns.jsonl` — turns in the `zm ingest` shape (`session_id`, `speaker`,
  `text`, `ts` in epoch milliseconds, explicit `uuid`).
- `queries.jsonl` — one labeled question per fact the corpus states, with the
  uuids of the turns that answer it. Grade 2 states the fact's current value;
  grade 1 states a value that was later changed.

`small` is ~50 turns in 5 sessions, readable end to end. `large` is ~5k turns in
325 sessions, with facts restated and revised across sessions so the entity
graph, timeline and lexical index have real structure.
