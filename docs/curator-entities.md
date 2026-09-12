# Curating the entity index

You are tidying the entity index of a zeromem memory store: the names the extractor pulled out of
the turns, which recall uses to pull a question's subject together with the turns that mention it.
Two jobs, both store-wide: fold a name that is another name for the same thing into it (`alias`),
and strike out a "name" that is not one (`block`). Nothing you do deletes a turn, and every action
can be undone — but an alias merges two subjects, so a wrong one makes recall answer a question
about one person with another person's turns. **When the turns do not settle it, skip.**

## What you may do here

| Op | Use it for | Shape |
| --- | --- | --- |
| `alias` | Two names for one entity. The alias folds into the canonical name in the entity index. | `{op: "alias", alias: "Maya", canonical: "Maya Okafor", reason}` |
| `unalias` | Reversing an alias. | `{op: "unalias", alias: "Maya", reason}` |
| `block` | An "entity" the extractor got wrong, such as a capitalised common word. | `{op: "block", entity: "Sure", reason}` |
| `unblock` | Reversing a block. | `{op: "unblock", entity: "Sure", reason}` |
| `run_end` | Closing the run. | `{op: "run_end", summary, cursor}` |

## Procedure

1. **Orient.** Call `zeromem_curate_runs` for the `cursor` (you hand it back in step 5) and the
   limits. Pick a run id and use it for every call: `curate-entities-<UTC date>T<hhmm>Z`.

2. **Gather pairs.** Call `zeromem_curate_candidates {kind: "aliases"}`. Each candidate is a short
   name and a longer one it could belong to, with a score and how the short one is formed.
   - By default the finder only offers names mentioned after the cursor. Pass `since_turn_id: 0` for
     a pass over the whole index, which is what you want when you are doing entity work on its own.
   - Page with `offset` while `more` is true, and stop when you run out of budget.
   - If you were given one entity to work on, call `zeromem_curate_read {entity}` instead and judge
     the names that turn up beside it.

3. **Judge each pair by reading both names.** `zeromem_curate_read {entity: "Maya"}` and
   `zeromem_curate_read {entity: "Maya Okafor"}` return every turn mentioning each.
   - **Alias** only when the two sets show one entity: the same sessions, the same role, the same
     relationships, the same work. Two people who share a first name are not aliases, and neither
     are a service and the team that owns it, however often they appear together.
   - The **canonical** name is the fuller, more specific one — the one a person would use to be
     unambiguous ("Maya Okafor", "Heron service").
   - A short name used for two different entities in different sessions is not an alias of either.
     Skip it; ambiguity is not something an alias can express.
   - **Block** only clear extraction mistakes: a sentence-initial common word ("Sure", "Thanks",
     "Actually"), a stray capitalised fragment. Never block a real name because it is noisy or rare —
     blocking removes it from the graph and from recall's entity view everywhere.
   - The `reason` names the evidence: `"'Heron' = 'Heron service', same sessions and owners"`,
     `"'Sure' is a sentence opener, 41 mentions, no referent"`.

4. **Dry run, then apply.** `zeromem_curate_apply {run_id, dry_run: true, actions}`, fix or drop what
   comes back with an `error`, then apply without `dry_run` in batches no larger than `max_per_call`.
   An alias or a block re-derives the entity tables, so every other process picks it up on its next
   read; undo one with `zeromem_curate_undo {action_id}`.

5. **Close the run, keeping the cursor.** Call
   `zeromem_curate_apply {run_id, actions: [{op: "run_end", summary, cursor: <the cursor from step 1>}]}`.
   This run judged names, not turns; leave `cursor` out and it would advance to the newest turn old
   enough to curate, and the next full sweep would skip everything nobody has read yet.

6. **Report.** Reply with the summary, the aliases and blocks you applied, and the pairs you left
   alone because the turns did not settle them.
