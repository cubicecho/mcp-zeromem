# Writing curator notes

You are consolidating a zeromem memory store: turning long old episodes into short notes that recall
can answer from. This is the one curation job that writes something new, so it is the one where a
mistake shows up as a confident wrong answer months later. A note is recalled like an ordinary turn
(`kind: note`, speaker `zeromem-curator`), and when a note and its sources both make the answer, the
sources fold under it. **Write nothing the sources do not say. When you are unsure, skip the
episode.**

## What you may do here

| Op | Use it for | Shape |
| --- | --- | --- |
| `note` | One episode: its lasting facts in a paragraph, standing for the turns it names. | `{op: "note", session_id, text, source_ids: [..], reason}` |
| `hide` | A turn inside an episode you are noting that is pure chatter. Optional; the note does not need it. | `{op: "hide", turn_ids: [..], reason}` |
| `run_end` | Closing the run. | `{op: "run_end", summary, cursor}` |

Undoing a note deletes it, so a bad note is recoverable — but only once someone notices it.

## Procedure

1. **Orient.** Call `zeromem_curate_runs` for the `cursor` (you hand it back in step 5), and for
   `max_per_call`, `max_per_run` and `min_age_ms`. Pick a run id and use it for every call:
   `curate-notes-<UTC date>T<hhmm>Z`.

2. **Find the episodes.** Call `zeromem_curate_candidates {kind: "consolidation"}` — long old
   episodes with no note yet, newest-ranked first, each with its turns and a reason. When `more` is
   true, page on with `offset`. If you were given a session to work on, skip this and take that
   session's turns as the episode.

3. **Read the whole episode before writing a word.** `zeromem_curate_read {session_id}` gives the
   turns with their flags and entity spans; `zeromem_read_session {session_id, limit, offset}` reads
   it in conversation order, which is how you tell what was decided from what was merely proposed.
   - Skip an episode whose turns already show a `covered_by`: it has a note.
   - Skip one you cannot follow. An episode you half understand produces a note that is half wrong.

4. **Write the note.**
   - One to six sentences, third person, plain declarative prose. No bullet lists, no headings, no
     "the user said" — write the facts, not the conversation about them.
   - Name people, places, systems and dates explicitly, as the turns spell them; a note that says
     "the team decided last week" answers nothing when it is recalled a year later.
   - Keep what still holds: decisions, current values, owners, outcomes. Drop what was superseded
     inside the episode, and drop the reasoning that led nowhere.
   - When the episode left something open, say so in the note — an unresolved question is a fact
     about the episode.
   - Nothing enters the note that the sources do not state. Do not carry in what you know from
     elsewhere in the store, and do not smooth a contradiction between two turns: leave both, or
     skip the episode.
   - `source_ids` are the turns the note stands for. `session_id` is their session.
   - The `reason` says why this episode was worth a note: `"14-turn Basalt incident, 2026-03; note
     keeps the cause and the owner"`.

5. **Dry run, then apply.** `zeromem_curate_apply {run_id, dry_run: true, actions}` first. A note
   rejected with "there is already a note for these sources" means someone got there first — drop
   it. Then apply without `dry_run`, in batches no larger than `max_per_call`. Re-read a note you
   just wrote with `zeromem_curate_read {turn_ids: [note_id]}` (the apply report gives `note_id`); if
   it says something the sources do not, undo it with `zeromem_curate_undo {action_id}`.

6. **Close the run, keeping the cursor.** Call
   `zeromem_curate_apply {run_id, actions: [{op: "run_end", summary, cursor: <the cursor from step 1>}]}`.
   Consolidation pages by `offset`, not by the cursor, so this run has not scanned the turns the full
   sweep still has to reach. Leave `cursor` out and the sweep would skip them.

7. **Report.** Reply with the summary, how many notes you wrote, and which episodes you skipped and
   why.
