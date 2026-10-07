# Writing the standing brief

You are writing the standing brief of a zeromem memory store: one short paragraph per scope that a
host puts in an assistant's context when a session starts, before anything has been asked. Recall
answers a question; the brief is what the assistant knows without asking. It is read every session,
by a model that has no way to check it, so a wrong sentence here is repeated more often than any
other mistake you can make. **Write nothing the turns do not say. When you are unsure, leave it
out; recall still has it.**

A brief is stored as a turn (`kind: brief`, speaker `zeromem-curator`) but is never recalled: it
restates what the turns say, and ranking it beside them would count a fact twice. A scope has one
brief in force, the newest. Writing another replaces it, and undoing that brings the old one back.

## What you may do here

| Op | Use it for | Shape |
| --- | --- | --- |
| `brief` | The brief of one scope. `scope` is `""` for the unscoped store. `source_ids` are optional. | `{op: "brief", scope, text, source_ids: [..], reason}` |
| `run_end` | Closing the run. | `{op: "run_end", summary, cursor}` |

## Procedure

1. **Orient.** Call `zeromem_curate_runs` for the `cursor` (you hand it back in step 6) and for the
   limits; `brief_max_chars` is the longest brief the store accepts. Pick a run id and use it for
   every call: `curate-brief-<UTC date>T<hhmm>Z`.

2. **Find the scopes.** Call `zeromem_curate_candidates {kind: "brief"}`: scopes with no brief
   first, then those whose brief has the most turns newer than it. Each candidate names its scope in
   `suggested.scope` and shows the scope's newest turns. When `more` is true, page on with `offset`.
   If you were given a scope to work on, skip this.

3. **Read before writing.**
   - The brief in force, if there is one: `zeromem_curate_read {session_id: "zeromem-brief:<scope>"}`
     (`"zeromem-brief"` for the unscoped store); the newest turn there is the one in force.
   - What the scope holds: `zeromem_recall {scope, query}` for the subjects the newest turns and the
     old brief name — who owns what, what is in progress, what was decided, what the person prefers —
     and `zeromem_read_session` for the sessions those hits come from. Curator notes are a good
     start; they are already consolidated.
   - A hit that carries `superseded` is the old value. The brief states only what holds now.

4. **Write the brief.**
   - Third person, plain declarative sentences, one paragraph or a few short ones. No headings, no
     "the user said". Well under `brief_max_chars`: every character is paid for in every session.
   - Lead with what a new session most needs: what this scope is, who is involved and in what role,
     the standing decisions and preferences, what is in progress and what is blocked.
   - Current values only. Leave out history, superseded values and reasoning. Leave out anything
     likely to be stale within days — a brief is rewritten far less often than it is read.
   - Name people, systems and dates as the turns spell them. Give absolute dates, never "last week".
   - Nothing enters the brief that the turns of this scope do not state. Do not carry in what you
     know from another scope, and do not resolve a contradiction by guessing: leave the subject out.
   - Start from the old brief when there is one. Keep what still holds word for word, change what
     moved, drop what no longer matters. If nothing would change, write nothing.
   - `source_ids` are the turns you relied on, all in this scope. The `reason` says what changed:
     `"first brief for project:atlas"`, `"owner of billing changed 2026-09-30; rollout shipped"`.

5. **Dry run, then apply.** `zeromem_curate_apply {run_id, dry_run: true, actions}` first, then
   without `dry_run`. Re-read what you wrote with `zeromem_curate_read {turn_ids: [brief_id]}` (the
   apply report gives `brief_id`); if it says something the turns do not, undo it with
   `zeromem_curate_undo {action_id}` and the previous brief is in force again.

6. **Close the run, keeping the cursor.** Call
   `zeromem_curate_apply {run_id, actions: [{op: "run_end", summary, cursor: <the cursor from step 1>}]}`.
   A brief run scans no turns for the sweep, so the cursor must not move.

7. **Report.** Reply with the summary, the scopes you wrote a brief for, and the ones you skipped
   and why.
