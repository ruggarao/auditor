# relay

Run `solidity-auditor`, `x-ray` and `fizz` as a chain of small fixed-budget
sessions instead of one long session with parallel subagents.

Built for the case where you have a hard per-session ceiling (e.g. $5), only one
model available at a time, and a codebase too big to fit in one context.

## Install

Copy `relay/` next to the root skills, so it can find them:

```
skills/
  solidity-auditor/
  x-ray/
  fizz/
  relay/          ← this
```

## Use

**First session** (planning only, cheap):

```
run relay on ./src with track solidity-auditor, budget $5
```

**Every session after** (one unit each, new chat):

```
resume relay in .
```

That is the whole interface. The session reads `.relay/`, picks the next unit, does
it, writes the result, prints a handoff, and stops.

## What it does not do

It does not shorten, summarize or drop any part of the original skills. All 12
auditor lenses, x-ray's full Step 2g taxonomy and fizz's five discovery lenses still
run — one per session instead of all at once. Lens files, gates and output templates
are read verbatim from the root skills at the moment they are used.

On a large codebase, lenses are **routed** by code traits rather than dropped, and
each gap-hunter additionally gets a cross-shard seam unit so cross-file bugs are
still hunted explicitly.

## Scripts

| script      | purpose                                                        |
| ----------- | -------------------------------------------------------------- |
| `relay.js`  | ledger: units, sessions, split/resume/recover, `LEDGER.md`      |
| `budget.js` | token ceiling from a $ budget, per-model rates, calibration     |
| `shard.js`  | measure code, score traits, expand (lens × shard) into a queue  |

```bash
node relay/scripts/relay.js --help
node relay/scripts/budget.js rates
node relay/scripts/shard.js scan --root . --src src --json
```

## Budget rates

`references/budget-profiles.md` holds per-model $/Mtok and context windows. The
figures shipped there are conservative placeholders — verify or, better, let
`budget.js calibrate` learn the real numbers from two or three measured units.
Observed data always overrides the table.

## Layout

```
relay/
  SKILL.md                       session kernel: boot, budget, run one unit, hand off
  references/budget-profiles.md  rates, 75/25 rule, calibration, model routing
  tracks/solidity-auditor.md     12 lenses + seams + the full dedup/gate ladder
  tracks/x-ray.md                sharded Step 2, fact-based synthesis, Step 3 writes
  tracks/fizz.md                 stateful suite build, coverage loop, campaigns
  scripts/{relay,budget,shard}.js
```

Everything a run produces lives in `.relay/` in the target repo. It is the artifact,
not scratch space — do not delete it between sessions.
