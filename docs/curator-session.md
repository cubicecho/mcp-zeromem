# Curating one session

You are curating **one session** of a zeromem memory store: the turns of a single conversation,
kept as they were said and recalled without a model. This is the pass that runs when a conversation
ends; sweeping the whole store is the `zeromem_curate` prompt's job, not this one. Stay inside the
session you were given. Nothing you do deletes anything — every action is logged with your reason
and can be undone — but a person has to notice a bad action before they can undo it. **Be
conservative: when you are unsure, skip.**

## What you may do here

| Op | Use it for | Shape |
| --- | --- | --- |
| `hide` | A noise turn, or a later copy of something the session already said. Recall leaves it out; it stays in the store and in session views. | `{op: "hide", turn_ids: [..], reason}` |
| `unhide` | Reversing a hide in this run. | `{op: "unhide", turn_ids: [..], reason}` |
| `supersede` | Turns whose value a later turn in the same conversation replaces. Recall shows the later turn in their place. | `{op: "supersede", turn_ids: [old..], by: new, reason}` |
| `note` | A long, settled session worth one paragraph. The note is recalled like a turn and its sources collapse under it. | `{op: "note", session_id, text, source_ids: [..], reason}` |
| `run_end` | Closing the run. | `{op: "run_end", summary, cursor}` |

Aliases and blocks are store-wide, not session work: leave them to the `zeromem_curate_entities`
prompt.

## Procedure

1. **Orient.** Call `zeromem_curate_runs`. Write down two things from it:
   - `cursor` — you hand this back unchanged in step 5, so that this run does not move it;
   - the limits: `max_per_call`, `max_per_run`, and `min_age_ms`, the age below which a turn is
     refused.

   Pick a run id and use it for every call: `curate-session-<session_id>-<UTC date>T<hhmm>Z`.

2. **Read the session whole.** Call `zeromem_curate_read {session_id}` — every turn in order with
   its entity spans and its curation flags (`hidden`, `superseded_by`, `supersedes`, `covered_by`,
   `sources`); hidden turns are included. Raise `limit` (up to 500) for a long session, and read the
   rest with `zeromem_read_session {session_id, limit, offset}`.
   - Leave alone what is already hidden, superseded or covered by a note.
   - If the conversation ended less than `min_age_ms` ago, its turns will all be refused as too
     young. Stop and run later rather than curating half of it.

3. **Judge, in this order.** You have the whole conversation in front of you, so judge each turn by
   what came before and after it rather than by the turn alone.
   - **Noise.** Hide chatter ("ok", "thanks", "sounds good"), and pasted output that no future
     question would be answered by. Keep anything carrying a decision, a name, a number, a date, or
     an error that was the subject of the conversation.
   - **Duplicates.** Hide a later turn only when it repeats an earlier one with the same values and
     adds nothing. A question asked twice with different answers is not a duplicate, and a summary
     that gathers what was decided is not one either — it is usually the turn worth keeping.
   - **Supersession.** When the conversation settles on a new value for the same attribute of the
     same subject, supersede the earlier turns by the turn that states the final one: "let's ship
     Thursday" … "make it Friday" supersedes the first. Both turns staying true means it is not a
     supersession, and a turn may never supersede one newer than it.
   - **A note**, but only for a long session (roughly twenty turns or more) that no note covers yet.
     One to six sentences, third person, in the past tense for what happened and the present for what
     still holds. Keep the decisions, the current values, and the names, places and dates, spelled
     out. Nothing may appear that the turns do not say. `source_ids` are the turns it stands for —
     the episode itself, not the whole session — and do not include turns you hid in this run.

   Write each `reason` so a person reading the log later understands it without opening the turns:
   `"repeat of #412 (same deploy date)"`, `"#903 moved the date to Friday, replaces #880"`.

4. **Dry run, then apply.** Call `zeromem_curate_apply {run_id, dry_run: true, actions}`, fix or drop
   anything that comes back with an `error`, then send the same actions without `dry_run`, in batches
   no larger than `max_per_call`. Undo a mistake with `zeromem_curate_undo {action_id}`.

5. **Close the run, keeping the cursor.** Call
   `zeromem_curate_apply {run_id, actions: [{op: "run_end", summary, cursor: <the cursor from step 1>}]}`.

   Pass that `cursor` even though you did not use it. Left out, `run_end` advances the store's cursor
   to the newest turn old enough to curate, and the next full sweep would skip every turn outside this
   session that nobody has looked at yet.

6. **Report.** Reply with the summary and the counts per op, and say what you deliberately left alone.
