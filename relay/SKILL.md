---
name: relay
description: Run the long-session skills (solidity-auditor, x-ray, fizz) as a chain of small fixed-budget sessions. Use when a session has a hard credit/context ceiling (e.g. $5), when only one model is available at a time, when a codebase is too large to fit in one context, or when a previous run stopped partway and must resume. Triggers on "relay", "budget mode", "$5 session", "resume the audit", "continue where it left off".
---

# Relay

The root skills assume one long session with many parallel subagents. Relay runs the
**same work** as a chain of small sessions: one session does one unit, writes its
result to disk, and hands off. Nothing is dropped, summarized, or weakened — it is
**time-sliced instead of parallelised**.

```
        long session                          relay
   ┌────────────────────┐        ┌────┐ ┌────┐ ┌────┐ ┌────┐
   │ 12 agents in       │        │ $5 │→│ $5 │→│ $5 │→│ $5 │→ …
   │ parallel, one ctx  │   →    └────┘ └────┘ └────┘ └────┘
   └────────────────────┘           └──── .relay/ on disk ────┘
```

**The contract: the ledger is the only memory.** A session is disposable. If it
did not write to `.relay/`, it did not happen.

## When to use which

| Situation                                            | Use                     |
| ---------------------------------------------------- | ----------------------- |
| One long session, no credit ceiling, parallel agents  | the root skill directly |
| Fixed per-session ceiling, one model, new chat each time | relay                 |
| Codebase larger than one context                      | relay                   |
| A relay run already exists in `.relay/`               | relay (it resumes)      |

Relay never replaces the root skills' *content*. Every lens, gate, template and
output format is read from the original skill files at the moment it is needed.

---

## Turn 1 — Boot (identical in every session, ~2k tokens)

Do these in **one message, parallel**:

a. `Bash: node <relay>/scripts/relay.js status --root .`
b. `Bash: node <relay>/scripts/relay.js next --root . --json`
c. `Read: <relay>/references/budget-profiles.md`

Then branch on (a):

- **`no relay state`** → this is a fresh run → go to [Turn 2 — Cold start](#turn-2--cold-start-first-session-only).
- **`status: done`** → print the final artifact paths and stop. Do not redo work.
- **anything else** → go to [Turn 3 — Run one unit](#turn-3--run-one-unit-every-later-session).

Never read the whole codebase in Turn 1. Never read a track file before you know
which unit you are running.

### Budget declaration

Immediately after boot, establish the session ceiling:

```bash
node <relay>/scripts/budget.js ceiling --model <opus-5|gpt-5.6-sol|kimi-k3|fable-5> --usd 5 --root .
```

It prints a **token ceiling**, a **checkpoint threshold at 75%**, and the
remaining-budget arithmetic. Treat the 75% line as a hard wall:

- **0–75%** — analysis, reading, tool calls.
- **75–100%** — reserved. Stop analysis. Write findings, close the unit, render
  the ledger, print the handoff. Never spend reserve on new analysis.

If you cannot measure tokens directly, use the proxy in `budget-profiles.md`
(tool-call and file-read counters calibrated per model). Announce the ceiling in
one line so the runner sees it, then never mention it again until checkpoint.

---

## Turn 2 — Cold start (first session only)

The first session's only job is to **plan**, not to analyse. Planning is cheap and
must never be interleaved with hunting.

1. Resolve paths. Glob for `**/references/hacking-agents/shared-rules.md`,
   `**/x-ray/SKILL.md`, `**/fizz/SKILL.md` as needed to locate the root skills.
   Store the winner as `{skill_root}`. Relay reads the originals from there.

2. Measure and shard the target:

   ```bash
   node <relay>/scripts/shard.js scan --root . --src <src-dir> --json
   ```

   This produces per-file nSLOC and **traits** (arith, access, value, external,
   state, paired, aggregate, bounds, entrypoints, upgradeable). Traits are how
   relay keeps full lens coverage on a big codebase — see below.

3. Build the unit queue:

   ```bash
   node <relay>/scripts/shard.js units --root . --track <solidity-auditor|x-ray|fizz> \
     --loc <total-nsloc> --shards <n> --out .relay/units.json
   ```

4. Initialise and plan:

   ```bash
   node <relay>/scripts/relay.js init --root . --track <track> --usd 5 --model <model>
   node <relay>/scripts/relay.js plan --root . --units .relay/units.json
   node <relay>/scripts/relay.js render --root .
   ```

5. Read the track file **once** (`<relay>/tracks/<track>.md`) and write any
   track-specific boot facts into `.relay/facts/`. Then print the handoff and
   **stop**. Do not start unit 1 in the planning session unless the ledger says
   the budget is >60% unused.

### Why sharding does not lose coverage

Dropping lenses to fit a budget would lose capability. Relay instead **routes**
them. Each lens is scored against each shard's traits; every lens keeps its
strongest ground and every shard gets its strongest lens before any second pass
is scheduled. On top of that, each gap-hunter lens gets a **cross-shard seam
unit** that reads `MAP.md` plus all prior findings, so cross-file bugs — the
thing a naive per-file split destroys — are still hunted explicitly.

Result: on a small codebase the queue is (12 lenses × 1 shard) = the original
12-agent sweep. On a large one it is the same 12 lenses, routed by density, plus
seam passes. Same lenses, same rules, more sessions.

---

## Turn 3 — Run one unit (every later session)

`relay.js next` returned a unit. **One session runs exactly one unit.** Do not
opportunistically start a second unit; a half-done second unit is worse than an
unstarted one.

1. **Claim it** (marks `in_flight`, so a crashed session is recoverable):

   ```bash
   node <relay>/scripts/relay.js session-start --root . --id <unit-id> --model <model> --ceiling <tokens>
   ```

2. **Load only what the unit needs.** The unit JSON carries `lens_file`,
   `files`, `deps` and `notes`. Read, in one parallel message:
   - the unit's `lens_file` from `{skill_root}` (the original, verbatim)
   - `references/hacking-agents/shared-rules.md` + `senior-auditor-sop.md` for
     audit units (or the track's stated equivalents)
   - **only** the shard's `files`
   - `.relay/MAP.md` and the specific `.relay/facts/*.md` the unit lists

   Do not read other shards' source. That is the whole point.

3. **Do the work** exactly as the original skill specifies. The track file maps
   the unit's `kind` to the original skill's step and tells you which sections
   are binding. The lens content, the finding format, the gates and the output
   templates are the originals — relay does not paraphrase them.

4. **Write results as you go, not at the end.** Append each finding the moment
   it is proven:

   ```bash
   node <relay>/scripts/relay.js done --root . --id <unit-id> --out .relay/findings/<unit-id>.md
   ```

   Findings live in `.relay/findings/`, one file per unit, in the original
   skill's output format. Durable facts other units will need go to
   `.relay/facts/`.

5. **Checkpoint at 75%.** If the unit is finished, `done` it. If it is not:

   ```bash
   node <relay>/scripts/relay.js split --root . --id <unit-id> \
     --remainder "<precisely what is left, in imperative form>" \
     --out .relay/findings/<unit-id>.md
   ```

   `split` closes the completed portion and queues the remainder as a new unit
   with the same lens and shard. Partial progress is preserved — never discarded.
   A remainder must be actionable by a session that has never seen this one:
   name files, functions and the exact next question.

6. **Close the session:**

   ```bash
   node <relay>/scripts/relay.js session-end --root . --tokens <used> --notes "<1 line>"
   node <relay>/scripts/budget.js calibrate --root . --model <model> --unit <unit-id> --tokens <used>
   node <relay>/scripts/relay.js render --root .
   ```

   `calibrate` records actual cost so the next session's ceiling is derived from
   observed behaviour rather than a guessed rate. This is the self-correcting
   loop the runner asked for: measure a real unit, and the estimates converge.

7. **Print the handoff** (below) and stop.

### If a unit is blocked

```bash
node <relay>/scripts/relay.js block --root . --id <unit-id> --reason "<what is missing>"
```

Blocked units are surfaced at the top of `LEDGER.md` and skipped by `next`, so a
missing dependency never stalls the chain. Use `requeue` once it is resolved.

### If a previous session died mid-unit

`status` shows a stale `in_flight` unit. Run:

```bash
node <relay>/scripts/relay.js recover --root .
```

It requeues anything left `in_flight` by a session that never ended, keeping any
findings already written. Nothing is lost, nothing is done twice.

---

## Turn 4 — Reduce (the last units)

Reduce units (`kind: reduce`) are where relay re-earns the parallel run's power.
The reducer reads **all** of `.relay/findings/`, not source, and applies the
original skill's reduction rules verbatim:

- for **solidity-auditor**: the full dedup ladder (group_key dedup → function-level
  second pass → function isolation → fix preservation with Option A/B → the
  completeness gate that prints `Completeness: N unique (Contract, function) in
  raw, N covered in final`), then `judging.md`'s four gates, then
  `report-formatting.md`.
- for **x-ray**: the write units emit the original four artifacts plus the SVG.
- for **fizz**: the synthesizer merges the five discovery lenses into
  `property-plan.md` before implementation.

Because every finding was appended to disk in the original format, the reducer
sees exactly what a 12-agent parallel run would have handed it. Reduction is
finding-bound, not source-bound, so it fits a small session even on a 50k-LOC
target.

If the reducer cannot fit all findings in one session, it reduces in passes:
group by contract, write a partial merged report, and `split`. The completeness
gate runs on the final pass over the merged set — never on a partial one.

---

## Handoff block (mandatory, last thing every session prints)

```
──── RELAY HANDOFF ────
track      : <track>            run: <run-id>
unit       : <unit-id>  → <done | split | blocked>
progress   : <n>/<total> units   findings: <n>
budget     : <used>/<ceiling> tokens (<pct>%)
next unit  : <id> — <one-line description>
next model : <suggestion, per budget-profiles.md>
to resume  : open a new chat, load the relay skill, say "resume relay in <root>"
───────────────────────
```

The runner should be able to start the next session by pasting nothing but that
last line.

## Constraints

- One unit per session. No exceptions.
- Never analyse in the reserve band. Findings-in-progress that miss the
  checkpoint are `split`, not rushed.
- Never re-read source in a reduce unit.
- Never weaken, shorten or paraphrase an original lens, gate or template. Read it
  from `{skill_root}` at use time.
- Never mark a unit `done` unless its output file exists and is in the original
  format.
- Never delete `.relay/`. It is the artifact, not scratch space.
- If `status` says `done`, stop. Re-running costs money and changes nothing.

## Files

| Path                        | Role                                                   |
| --------------------------- | ------------------------------------------------------ |
| `.relay/state.json`         | machine state — units, sessions, budget (schema-checked) |
| `.relay/LEDGER.md`          | human-readable progress board, re-rendered each session |
| `.relay/BUDGET.md`          | observed cost per unit; feeds `calibrate`               |
| `.relay/MAP.md`             | shard digest — what every session may read cheaply      |
| `.relay/units.json`         | the planned queue                                       |
| `.relay/findings/<unit>.md` | per-unit output, original format                        |
| `.relay/facts/<topic>.md`   | durable cross-unit facts                                |

| Reference                            | Read when                          |
| ------------------------------------ | ---------------------------------- |
| `references/budget-profiles.md`      | every session (Turn 1)             |
| `tracks/solidity-auditor.md`         | running an `A-*` unit              |
| `tracks/x-ray.md`                    | running an `X-*` unit              |
| `tracks/fizz.md`                     | running an `F-*` unit              |
