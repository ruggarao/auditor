# Track: solidity-auditor

Maps relay units onto `solidity-auditor/SKILL.md`. The 12 agents that ran in
parallel now run **one per session**, over routed shards. Every lens file, the
SOP, the shared rules, the four gates and the report format are read **verbatim
from the original skill** — this file only says which unit runs which step.

`{skill_root}` = the directory containing `solidity-auditor/`, resolved by globbing
`**/references/hacking-agents/shared-rules.md` and going two levels up.

## Scope

Same exclude pattern as the original: skip `interfaces/`, `lib/`, `mocks/`,
`test/`, and `*.t.sol`, `*Test*.sol`, `*Mock*.sol`. Use Bash `find`, not Glob.

## Unit map

| unit id                  | kind      | original step                            |
| ------------------------ | --------- | ---------------------------------------- |
| `A-map`                  | `map`     | Turn 2 prep, as a shard digest            |
| `A-<lens>-s<n>`          | `scan`    | Turn 3a — one lens over one shard         |
| `A-seam-<lens>`          | `seam`    | Turn 3a-ii — gap-hunter, cross-shard      |
| `A-reduce`               | `reduce`  | Turn 4 — dedup, gate, report              |

The 12 lens ids are exactly the original 12: `math-precision`, `access-control`,
`economic-security`, `execution-trace`, `invariant`, `periphery`,
`first-principles`, `asymmetry`, `boundary` (specialty, prompt 3a-i) and
`numerical-gap`, `trust-gap`, `flow-gap` (gap-hunter, prompt 3a-ii).

Skip the original's Turn 1b model question entirely. Relay's model choice is the
runner's choice of chat, and the handoff suggests the next one.

## `A-map` — the digest that replaces `source.md`

The original concatenated all source into `source.md` and appended it to all 12
bundles. Relay cannot afford that per session, so this unit builds a digest once
and every later unit reads it instead.

Write `.relay/MAP.md`:

```markdown
# MAP

## Shards
| shard | files | nSLOC | traits | risk |
|-------|-------|------:|--------|-----:|

## Contracts
| contract | file | shard | inherits | state vars | entry points |

## External surface
| contract.function | visibility | modifiers | value-moving | shard |

## Cross-shard edges
<caller shard> → <callee shard> : <contract.function> → <contract.function>

## Trust model
- roles and who holds them
- upgradeability, pausability
- external dependencies (oracles, tokens, routers)
```

`Cross-shard edges` is the most important section — it is what makes the seam
units possible. Every external call, callback and shared-storage write that
crosses a shard boundary must be listed. Do not summarise it away.

Then write `.relay/facts/invariants-candidate.md`: every conservation, monotonicity
and accounting relation you can name from signatures and state, one per line. Seam
units use it to know what "broken" means without re-reading source.

Cheap unit. Prefer `kimi-k3`. No findings.

## `A-<lens>-s<n>` — one lens, one shard

This is the original Turn 3a agent, unchanged in mindset and rules.

Read in one parallel message:

1. `{skill_root}/solidity-auditor/references/hacking-agents/<lens>-agent.md`
2. `{skill_root}/solidity-auditor/references/senior-auditor-sop.md`
3. `{skill_root}/solidity-auditor/references/hacking-agents/shared-rules.md`
4. the unit's `files` — **only** those
5. `.relay/MAP.md`

That set is the original's `agent-N-bundle.md`, assembled by reading instead of
`cat`. Same four ingredients; the only difference is that source is the shard, not
the world.

Then adopt the original prompt verbatim in spirit:

> You are an attacker. Your specialty, mindset, source, and output rules are in
> your bundle. Read it fully before producing findings.
> A finding is: file, function, root cause (one sentence, code-level), minimal fix,
> proof (concrete numbers, a trace, or quoted code).
> Without concrete proof, it's a LEAD, not a finding. Leads are honest about what
> you couldn't verify — they're not failures, they're calibration. Emit them.
> Don't skim. Don't trust your first read. Trust your discomfort.

Gap-hunter lenses (`numerical-gap`, `trust-gap`, `flow-gap`) additionally carry the
`seam:` field — which two or three lenses combine — per prompt 3a-ii.

Out-of-shard reads: **targeted only.** Grep for a specific symbol, read a specific
interface. If you find yourself reading another shard whole, stop and record a seam
note in `.relay/facts/seams.md` instead — that is a seam unit's job, and you would
blow the budget doing it here.

Output format is `shared-rules.md`'s, exactly. Append to
`.relay/findings/A-<lens>-s<n>.md` with this header:

```markdown
# A-<lens>-s<n>
lens: <lens>   shard: s<n>   files: <n>   session: <id>   model: <model>
coverage: <which functions you actually examined>
```

The `coverage:` line is not optional. The reducer's completeness gate needs to know
what was examined versus what was merely in scope, and a later session may need to
re-queue a function that was skipped for budget.

## `A-seam-<lens>` — cross-shard, the part naive splitting loses

Depends on all wave-1 scans. Reads **no shard whole**:

1. the gap-hunter lens file + `shared-rules.md` + SOP
2. `.relay/MAP.md` — especially `Cross-shard edges`
3. **all** of `.relay/findings/*.md`
4. `.relay/facts/invariants-candidate.md` and `seams.md`
5. targeted Reads/Greps of specific functions named in 2–4 only

Hunt in this order:

1. **Edge seams** — every cross-shard edge in MAP: does the caller's assumption
   hold on the callee's side? Mismatched units, decimals, rounding direction,
   reentrancy window, missing check the caller assumed the callee makes.
2. **Finding seams** — two shards each with an accepted-looking behaviour that is
   unsafe *in combination*. This is where the original's composite chains live.
3. **Invariant seams** — for each candidate invariant, which shard could break it
   without any single shard's lens noticing.
4. **Skipped-coverage seams** — functions that appear in no scan unit's `coverage:`
   line. Anything unexamined is a hole; hunt it or record it as a lead.

Emit composite chains in the original form: `Chain: [A] + [B]` at
`conf = min(A, B)`, when A's output feeds B's precondition **and** combined impact
exceeds either alone. The original expects 0–2 per audit; do not manufacture more.

Prefer `opus-5`. This is the hardest unit in the track and the one where budget
economy costs findings.

## `A-reduce` — dedup, gate, report

Depends on every scan and seam unit. Reads `.relay/findings/*.md`,
`{skill_root}/solidity-auditor/references/judging.md` and
`report-formatting.md`. **Never reads source** — the original forbids
re-verification here too ("agents did that, dedup filtered... Skip").

Apply the original Turn 4 ladder in order, nothing skipped:

1. **Dedup** by `group_key` (Contract | function | bug-class); exact match first,
   then merge synonymous `bug_class` within the same (Contract, function). Number
   sequentially, annotate `[agents: N]` — where N counts **units** that flagged it.
2. **Wide description** — a merged group with distinct mechanisms must list every
   mechanism. No dropping.
3. **Function-level second pass** — re-run at (Contract, function) ignoring
   bug_class; scan every constituent body for mechanisms that crossed bug_class
   labels. Every mechanism in any body must appear in ≥1 final finding.
4. **Function isolation (HARD)** — never merge across different `function:` values.
   The second pass stays *within* (Contract, function), never across.
5. **Fix preservation (HARD GATE)** — collect every raw `fix:`, group by ADD-lines,
   treat as distinct when the called expression, check direction or checked
   parameter differs. ≥2 distinct → emit `**Fix (Option A — <label>)**`,
   `**Fix (Option B — <label>)**`, verbatim diffs, no paraphrase. Labels:
   validate / restrict / allow-and-handle / ban-path.
6. **Completeness (HARD GATE)** — enumerate every unique (Contract, function) in
   any raw FINDING or LEAD; each must have ≥1 item in the final report. Print
   before the report:
   `Completeness: N unique (Contract, function) in raw, N covered in final.`
7. **Gate** — each deduped finding through `judging.md`'s four gates, no skip, no
   reorder, no revisit after verdict. Single-pass, fixed order
   (constructor → setters → swap → mint → burn → liquidate), one-line verdict:
   `BLOCKS` / `ALLOWS` / `IRRELEVANT` / `UNCERTAIN`. `UNCERTAIN = ALLOWS`. Commit.
8. **Lead promotion** — LEAD → FINDING at conf 75 if a full exploit chain exists in
   source, or if `[agents: 2+]` was demoted rather than rejected for the same issue.
   `[agents: 2+]` does **not** override a code path that interrupts the attack
   before harm — demote to LEAD when execution is uncertain. No deployer-intent
   reasoning: judge what the code allows.
9. **Format** per `report-formatting.md`, excluding rejected. Write to
   `.relay/report.md` — relay always writes the file, since a chat's scrollback is
   not a deliverable. Also print it.

Relay does **not** delete `.relay/` (the original's Turn 5 auto-clean applies to
its transient bundle dir, which relay never creates). The ledger and findings are
the artifact.

### Reducing in passes

If all findings do not fit one session: group by contract, write
`.relay/report-partial-<n>.md`, `split` with a remainder naming the contracts left.
Steps 1–5 run per pass. Steps 6–9 run **only on the final pass** over the merged
set — a completeness gate on a partial set is meaningless and must not be printed.

## Definition of done

- every `A-*` unit `done` or `blocked` with a recorded reason
- every scan unit's findings file has a `coverage:` line
- `Completeness:` line printed on the final reduce pass
- `.relay/report.md` exists in `report-formatting.md`'s format
