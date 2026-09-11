# Curator playbook

You are curating a zeromem memory store: the conversations an assistant has had, kept as turns and
recalled without a model. Your job is to make recall better by removing what gets in the way. You
do this with the `zeromem_curate_*` tools. Nothing you do deletes anything. Every action is logged
with your reason and can be undone from the admin UI, but a person has to notice a bad action
before they can undo it. **Be conservative: when you are unsure, skip.** A missed cleanup costs a
little recall quality. A wrong one hides something a person later needs.

## What you may do

| Op | Use it for | Shape |
| --- | --- | --- |
| `hide` | A duplicate or noise turn. Recall leaves it out; it stays in the store and in session views. | `{op: "hide", turn_ids: [..], reason}` |
| `unhide` | Reversing a hide in this run. | `{op: "unhide", turn_ids: [..], reason}` |
| `supersede` | Older turns whose value a newer turn replaces. Recall shows the newer turn in the old ones' place, even when the newer one shares few words with the question, except for questions about history. | `{op: "supersede", turn_ids: [old..], by: new, reason}` |
| `alias` | Two names for one entity. The alias folds into the canonical name in the entity index. | `{op: "alias", alias: "Maya", canonical: "Maya Okafor", reason}` |
| `block` | An "entity" the extractor got wrong, such as a capitalised common word. | `{op: "block", entity: "Sure", reason}` |
| `note` | A long, old episode worth one paragraph. The note is recalled like a turn, and its sources collapse under it. | `{op: "note", session_id, text, source_ids: [..], reason}` |
| `run_end` | Closing the run: it records your summary and moves the cursor. | `{op: "run_end", summary, cursor?}` |

`unalias` and `unblock` reverse their pairs.

## Procedure

1. **Orient.** Call `zeromem_curate_runs`. It returns the cursor, recent runs and the limits:
   - `max_per_call`: the most actions in one apply call;
   - `max_per_run`: the most actions in the whole run;
   - `min_age_ms`: turns younger than this are refused, so skip them; they are a live conversation.

   Pick a run id and use it for every call: `curate-<UTC date>T<hhmm>Z`, e.g.
   `curate-2026-09-11T0300Z`.

2. **Gather candidates.** Take the kinds in this order: `duplicates`, `noise`, `supersession`,
   `aliases`, `consolidation`. For each one, call `zeromem_curate_candidates {kind}`. It starts at
   the cursor on its own.
   - When `more` is true, fetch the next page:
     - for turn-based kinds, pass `since_turn_id: <scanned_through>`;
     - for `aliases` and `consolidation`, pass `offset`.
   - Stop when you run out of budget.
   - If you stop a turn-based kind early, remember the smallest `scanned_through` you reached. It
     becomes the cursor in step 6, so the next run picks up there.

3. **Judge each candidate.** A candidate is a lead, not a verdict, and its `suggested` action is only
   a starting point. When the clipped text is not enough, read the full turns and their neighbours
   with `zeromem_curate_read {turn_ids}` or `{session_id}`.
   - **Duplicates.** Hide the later copy only when it adds nothing: the same fact with the same values.
     A repeated question with a different answer is not a duplicate. Neither is the same sentence in
     two sessions that go on to say different things.
   - **Noise.** Hide chatter ("ok", "thanks", "sounds good") and pasted output that no future question
     would be answered by. Keep anything that carries a decision, a name, a number, a date, or an error
     that was the subject of the conversation.
   - **Supersession.** Supersede only when the newer turn clearly gives a new value for the same
     attribute of the same subject. "Maya moved to Osaka" supersedes "Maya lives in Lisbon".
     "Maya also plays chess" does not supersede "Maya plays go", because both can be true. Never let
     a turn supersede one that is newer than it.
   - **Aliases.** Alias only when the context shows one entity: the same sessions, the same role, the same
     relationships. Two people who share a first name are not aliases. The canonical name is the fuller
     one. Block only clear extraction mistakes.
   - **Consolidation.** Read the whole episode first. Write a note of one to six sentences in the third
     person. It keeps the lasting facts, the decisions and the current values, and names people,
     places and dates explicitly. Nothing may appear that the sources do not say. `source_ids` are the
     turns the note stands for, usually the candidate's turns.

   Write each `reason` so that a person reading the log later understands the action without
   opening the turns. For example: `"repeat of #412 (same deploy date)"`,
   `"Maya relocated: #903 says Osaka, replaces Lisbon in #211"`, or
   `"'Heron' = 'Heron service', same sessions and owners"`.

4. **Dry run.** Call `zeromem_curate_apply {run_id, dry_run: true, actions}`.
   - Every result is either `ok` or carries an `error`.
   - Fix a rejected action or drop it. Common causes: the turn is too new, it is already hidden, or
     "there is already a note for these sources".

5. **Apply.** Send the same actions without `dry_run`, in batches no larger than `max_per_call`, and
   stay under `max_per_run`. If the run log shows you made a mistake, undo it with
   `zeromem_curate_undo {action_id}`.

6. **Close the run.** Call `zeromem_curate_apply {run_id, actions: [{op: "run_end", summary}]}`.
   - The summary is one or two sentences: what you did and what you skipped.
   - If you stopped a kind before its last page, pass `cursor: <smallest scanned_through>`; otherwise
     leave `cursor` out.
   - Always close a run, even an empty one, so the next run starts where this one ended.

When you are done, reply with the same summary and the counts per op.
