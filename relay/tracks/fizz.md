# Track: fizz

Maps relay units onto `fizz/SKILL.md`. fizz is the hardest track to slice because
it is **stateful**: it builds a fuzzing suite on disk, compiles it, and iterates
coverage. The good news is that the suite itself is durable state — so relay's
per-session handoff is mostly "the repo compiles, here is where I stopped".

`{skill_root}` = the directory containing `fizz/`. All templates, references and
scripts are read/run from there, verbatim.

**Golden rule for this track: never end a session on a non-compiling tree.**
A broken build is the one handoff a fresh session cannot cheaply recover from.
If the build is broken at checkpoint, spend the reserve fixing or reverting it, and
say which in the remainder.

## Unit map

| unit id                | kind         | original step                                    |
| ---------------------- | ------------ | ------------------------------------------------ |
| `F-tooling`            | `setup`      | Steps 0–2 — banner, tooling, build, extract ABIs  |
| `F-understand`         | `map`        | Step 3 — protocol understanding (+ x-ray acquire) |
| `F-select`             | `setup`      | Steps 4–4.5 — entry-point selection, cost estimate |
| `F-scaffold`           | `write`      | Step 5 — generate scaffold                        |
| `F-setup`              | `write`      | Step 6 — wire `Base.sol` `setup()` until it builds |
| `F-handlers-s<n>`      | `write`      | Step 7 — handlers for this shard                  |
| `F-coverage-1`         | `loop`       | Step 8 — coverage cycle                           |
| `F-discover-<lens>`    | `scan`       | Step 9b — one invariant-discovery lens            |
| `F-synthesize`         | `reduce`     | Step 9c — synthesizer → property plan             |
| `F-impl-global`        | `write`      | Step 9d — global property implementer             |
| `F-impl-specific`      | `write`      | Step 9d — specific property implementer           |
| `F-validate`           | `setup`      | Step 9e — build, fix compile errors               |
| `F-campaign-<n>`       | `loop`       | Step 10 — campaign run + interpretation           |
| `F-report`             | `reduce`     | Step 11 — repros, final report, snapshot          |

The five discovery lenses keep their original ids and files:
`conservation-auditor`, `roundtrip-rounding-analyst`, `state-transition-mapper`,
`adversarial-profit-maximizer`, `protocol-type-specialist`.

Skip the original's `{AGENT_MODEL}` resolution (Step: Subagent Model) — relay's
model is the chat the runner opened. `{MODE}` still resolves per the original.

## `F-tooling` — Steps 0–2

```bash
bash {skill_root}/fizz/scripts/ensure_foundry.sh
forge build
node {skill_root}/fizz/scripts/extract_abis.js
```

Record in `.relay/facts/tooling.md`: forge/medusa/echidna versions, build profile,
via-IR on/off, ABI output path, resolved `{MODE}`. Later sessions must not have to
re-derive any of it.

If `forge build` fails, `block` the unit with the compiler error. Do not proceed —
every later unit depends on a building tree.

## `F-understand` — Step 3

Follow the original's **x-ray acquisition protocol**: if an x-ray exists, read it;
if not, produce protocol understanding via `agents/protocol-analyzer.md`. In relay,
a missing x-ray is best solved by running the `x-ray` relay track first and
pointing this unit at its output — the two tracks share `.relay/` happily when run
from different roots, and reusing an x-ray is far cheaper than re-deriving it.

Write `.relay/MAP.md` (shards, contracts, cross-shard edges) and
`.relay/facts/protocol.md` (protocol type, actors, value flows, external deps).

## `F-select` — Steps 4 + 4.5

Read `{skill_root}/fizz/references/selection-policy.md`. Select entry points and
tier them; apply the **dispatcher pattern for low-frequency functions** exactly as
the original specifies. Then:

```bash
node {skill_root}/fizz/scripts/select_functions.js
node {skill_root}/fizz/scripts/estimate_cost.js
```

Write the selection and the cost estimate to `.relay/facts/selection.md`. The
selection list is the contract every handler unit works against — if it changes
later, the handler units must be re-queued, so get it right here.

## `F-scaffold` + `F-setup` — Steps 5 + 6

```bash
node {skill_root}/fizz/scripts/generate_suite.js
bash {skill_root}/fizz/scripts/setup_fuzz_profile.sh
```

`F-setup` follows `{skill_root}/fizz/references/setup-playbook.md` and
`templates/README.md` + `template-map.md` to wire `Base.sol`'s `setup()`,
`Deployer`, actors and mocks. Its exit criterion is binary and non-negotiable:
**`forge build` passes.** Nothing else in this unit matters, and it may not be
marked `done` otherwise — `split` with the remaining compile errors verbatim in the
remainder instead.

## `F-handlers-s<n>` — Step 7, sharded

```bash
node {skill_root}/fizz/scripts/generate_handlers.js
```

Generation is global and cheap; **refinement** is what relay shards. Each unit
refines handlers for its shard's contracts only, per
`{skill_root}/fizz/references/handler-patterns.md`: clamping, actor selection,
precondition handling, ghost-variable updates.

Read only this shard's source, the generated handler files for it, and
`handler-patterns.md`. End on a building tree; run `forge build` before closing.

## `F-coverage-1` — Step 8

The coverage loop, per the original, including:

- **via-IR coverage deflation handling** — detect the profile and apply the
  original's workaround before believing any coverage number.
- **dynamic coverage targets** — computed per the original, not a fixed percentage.
- **the coverage iteration loop** — with `{skill_root}/fizz/scripts/run_medusa.js`.
- **acceptable skip reasons** — only the original's list. A function skipped for any
  other reason is unfinished work: record it in the remainder rather than excusing it.

Write `.relay/facts/coverage.md`: per-function coverage, unreached functions with
reasons, current target. If the target is not met at checkpoint, `split` — the
sharder queues `F-coverage-<n+1>` and the next session continues from the recorded
state, which is why per-function numbers must be written down.

Long logs make this unit context-hungry. Prefer `gpt-5.6-sol`, and use
`{skill_root}/fizz/scripts/lib/log-viewer.js` rather than reading raw logs.

## `F-discover-<lens>` — Step 9b, one lens per session

The original ran five discovery agents in parallel; relay runs one per session.

First, ensure the Step 9a **invariant context** exists at
`.relay/facts/invariant-context.md` (built by `F-understand`/`F-coverage-1`): state
variables, accounting relations, actor set, value flows, coverage status. Each
discovery unit reads that plus its own lens file:

`{skill_root}/fizz/agents/invariant-discovery/<lens>.md`

Read `{skill_root}/fizz/references/property-generation.md` for the output shape, and
write proposals to `.relay/findings/F-discover-<lens>.md`. Source reads are limited
to the lens's routed shard plus targeted lookups — the invariant context is meant to
carry the cross-shard picture.

Each proposed property must state: the invariant in plain language, the state it
reads, how to compute it in Solidity, and what a violation would mean. Vague
proposals cost the synthesizer more than they are worth.

## `F-synthesize` — Step 9c

Reads all five `F-discover-*` files and
`{skill_root}/fizz/agents/invariant-discovery/synthesizer.md`. No source.

Deduplicate, resolve contradictions, rank by expected value, and emit
`.relay/property-plan.md` plus `PROPERTIES.md` per the original. Split global versus
specific properties, because the two implementer units consume them separately.

If the five lens outputs do not fit one session, reduce in passes by property
family and `split`; the final pass produces the authoritative plan.

## `F-impl-global` / `F-impl-specific` — Step 9d

Each reads `.relay/property-plan.md`, its implementer spec
(`{skill_root}/fizz/agents/implementers/{global,specific}-property-implementer.md`),
`references/property-generation.md`, and `templates/Properties.sol`.

Implement only its half. Both may not be run in the same session — they touch the
same files and a merge conflict inside a $5 session is a wasted session.

## `F-validate` — Step 9e

`forge build`, fix compile errors, ensure every implemented property is registered.
Exit criterion: clean build. Same rule as `F-setup` — never close this unit on a
broken tree.

## `F-campaign-<n>` — Step 10

Select the fuzzer per the original's **fuzzer selection** rules, then:

```bash
node {skill_root}/fizz/scripts/run_medusa.js    # or run_echidna.js
```

Interpret results per Step 10's **interpreting results**, and record in
`.relay/facts/campaign-<n>.md`: config, duration, calls, violations with shrunk
sequences, and coverage delta.

Campaigns are wall-clock bound, not token bound. Start the campaign, let it run,
then interpret — do not idle-poll inside a budgeted session. Per the original's
**campaign iteration**, if the campaign found nothing and coverage is short,
`split` into `F-campaign-<n+1>` with the recorded config as the starting point.

## `F-report` — Step 11

Reads all `.relay/facts/campaign-*.md` and findings, plus
`{skill_root}/fizz/agents/report-writer.md`.

1. **Generate violation repros** per Step 11 — a standalone Foundry test per
   violation, each one actually run and confirmed failing. An unreproduced violation
   is a lead, not a finding.
2. **Final report** in the original's format → `.relay/report.md`.
3. **Snapshot for future re-use** per Step 11's snapshot section, so a later run
   starts from this suite instead of rebuilding it.

## Definition of done

- suite builds clean; coverage target met or every gap has an acceptable skip reason
- all five discovery lenses ran; plan synthesized; both implementer halves done
- every violation has a confirmed failing repro
- `.relay/report.md` written and snapshot saved

## Related sub-skills

`fizz/skills/fizz-sync/` and `fizz/skills/fizz-convert/` are already single-purpose
and short. Run them directly in their own session; they need no relay decomposition.
