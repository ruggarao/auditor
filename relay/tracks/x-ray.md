# Track: x-ray

Maps relay units onto `x-ray/SKILL.md`. x-ray's expensive part is Step 2 — reading
every source file and extracting deltas, guards, transitions and entry points.
Relay shards that read and lets the synthesis steps run on **extracted facts**
instead of source, which is what makes a 50k-LOC target fit in $5 slices.

`{skill_root}` = the directory containing `x-ray/`. Its `references/templates.md`
and `references/threats.md` are binding — read them at use time, never from memory.

x-ray already mandates progress tracking. Relay's ledger **is** that tracker;
`.relay/LEDGER.md` satisfies it. Do not maintain a second progress file.

## Unit map

| unit id                | kind          | original step                                              |
| ---------------------- | ------------- | ---------------------------------------------------------- |
| `X-enumerate`          | `map`         | Step 1 + Step 2f — enumerate, measure, git security, nSLOC  |
| `X-facts-s<n>`         | `extract`     | Step 2 + 2a — read shard, extract facts, entry-point grep   |
| `X-entrypoints`        | `synthesize`  | Step 2b + 2b-flow — classify, build flow paths              |
| `X-classify`           | `synthesize`  | Steps 2c, 2d, 2e — back-compat, centralization, pause, type |
| `X-invariants`         | `synthesize`  | Step 2g — invariant taxonomy walk + verification gate       |
| `X-write-invariants`   | `write`       | Step 3a — `invariants.md`                                   |
| `X-write-entrypoints`  | `write`       | Step 3a — `entry-points.md`                                 |
| `X-write-xray`         | `write`       | Step 3a — `x-ray.md` + `architecture.json`                  |
| `X-svg`                | `write`       | Step 3b + 3c — `architecture.svg`, audit loop, verdict      |

Path A / Path B in the original (≤20 files direct, >20 files subagents) collapses
into one rule here: **one `X-facts-s<n>` unit per shard.** The sharder sizes shards
so a session can read one whole. Small repos get one shard and the track behaves
exactly like Path A.

## `X-enumerate`

Run the original's own tooling rather than reimplementing it:

```bash
bash {skill_root}/x-ray/scripts/enumerate.sh <target>
python3 {skill_root}/x-ray/scripts/analyze_git_security.py <target>
```

Record into `.relay/facts/enumerate.md`: file inventory, nSLOC per file and total
(Step 2f), dependency and remapping list, build system, git security findings,
test inventory.

**Test existence vs coverage execution (CRITICAL, from Step 3).** Existence of test
files is not coverage. If you cannot execute the coverage tool, say so explicitly
and record `coverage: not executed` — never infer a coverage percentage from the
presence of tests. This distinction must survive into `X-write-xray`, so write it
down here verbatim.

**Branch scoping (CRITICAL, from Step 3a).** Record the exact commit/branch under
review in `.relay/facts/enumerate.md`. Every later unit's output must be scoped to
it, and a fresh session has no other way to know.

Then write `.relay/MAP.md` — shard table, contract table, inheritance, and
cross-shard edges (same shape as the auditor track's MAP; later units depend on it).

Cheap unit. Prefer `kimi-k3`.

## `X-facts-s<n>` — the sharded Step 2

For this shard's files only, produce `.relay/facts/X-facts-s<n>.md`. Use the
original's Step 2 per-file structure (`### [filename]` sections) and capture, per
contract and function:

- **state variables** — type, visibility, what invariant each participates in
- **deltas** — what each function changes, and by how much
- **guards** — every `require`/`revert`/modifier, and what it protects
- **transitions** — state machine edges, including the implicit ones
- **access** — who may call what, which role, which modifier
- **external calls** — target, value, callback risk, trust assumption
- **entry points** — from the Step 2a grep, both forms:

```bash
# single-line signatures
grep -rnE 'function +[A-Za-z0-9_]+ *\(.*\) *(external|public)' <files>
# multiline: visibility on the closing-paren line (covers 90%+ of cases)
grep -rnE '^\s*\)?\s*(external|public)\b' <files>
```

Run both. The multiline form is the one that is usually forgotten, and missing it
silently drops entry points from every downstream unit.

This unit produces **facts, not conclusions**. Do not classify entry points, do not
judge centralization, do not synthesize invariants here — those are separate units
precisely so they can see all shards at once. Recording a conclusion early, from
one shard, is how sharding loses fidelity.

Read only this shard's `files` plus `.relay/facts/enumerate.md`.

## `X-entrypoints` — Step 2b + 2b-flow

Depends on all `X-facts-*`. Reads facts files and `MAP.md`; source only for
targeted checks.

1. **Classify** every entry point per Step 2b's taxonomy.
2. **Build protocol flow paths** per Step 2b-flow: end-to-end paths through the
   protocol, each step naming contract, function and state effect. Flow paths that
   cross shards are the reason this unit reads all facts at once.

Write `.relay/facts/entrypoints.md`.

## `X-classify` — Steps 2c, 2d, 2e

Depends on all `X-facts-*`. One unit, four questions, from facts:

- **2c backwards-compatibility code** — dead or legacy paths kept for compat, and
  what they still allow.
- **2d centralization** — every privileged action, who holds it, blast radius.
- **2d pause coverage** — which entry points a pause actually stops, and, more
  importantly, which value-moving paths it does **not**.
- **2e protocol classification** — the protocol type, since it determines which
  threat classes in `references/threats.md` apply.

Write `.relay/facts/classification.md`.

## `X-invariants` — Step 2g

Depends on all `X-facts-*`. Read
`{skill_root}/x-ray/references/threats.md` and walk the **full** Step 2g taxonomy —
every category, including ones that look inapplicable, recording why when they are.
An abbreviated walk is the single easiest way to lose x-ray's value, and a budget
ceiling is not a licence to abbreviate: if the taxonomy does not fit, `split` and
finish the remaining categories next session.

Apply Step 2g's **verification gate** to each candidate invariant: it must be
traceable to specific state and specific functions, and you must name what would
break it. Unverifiable candidates are recorded as such, not silently dropped.

Write `.relay/facts/invariants.md` with, per invariant: statement, participating
state, enforcing functions, breaking conditions, verification status.

## Write units — Step 3a

Original Step 3a wrote four files in parallel. Relay writes them in three units,
ordered by dependency, each reading only the facts it needs and
`{skill_root}/x-ray/references/templates.md` for the exact format.

| unit                  | writes                              | reads                                            |
| --------------------- | ----------------------------------- | ------------------------------------------------ |
| `X-write-invariants`  | `invariants.md`                     | `facts/invariants.md`                            |
| `X-write-entrypoints` | `entry-points.md`                   | `facts/entrypoints.md`                           |
| `X-write-xray`        | `x-ray.md`, `architecture.json`     | all facts + the two written files                |

Formats come from `templates.md` verbatim. Every output is scoped to the branch
recorded in `X-enumerate`, and `x-ray.md` must carry the
`test existence vs coverage execution` distinction honestly.

## `X-svg` — Step 3b + 3c

```bash
python3 {skill_root}/x-ray/scripts/generate_svg.py <architecture.json> <out.svg>
```

Validate the SVG as Step 3b requires — if it fails validation, fix
`architecture.json` and regenerate rather than hand-editing the SVG. Then emit the
Step 3c terminal verdict and the recommended audit loop.

## Definition of done

- `invariants.md`, `entry-points.md`, `x-ray.md`, `architecture.json`,
  `architecture.svg` all exist, in `templates.md` format
- every output scoped to the recorded branch/commit
- coverage claim is honest about execution
- full Step 2g taxonomy walked (or remaining categories still queued, never dropped)
