# Budget profiles

Relay budgets in **tokens**, because tokens are the real constraint, and converts
to dollars through an editable rate table. Edit the table when prices change; the
scripts read these numbers, so nothing else needs touching.

## Rate table

Rates are USD per **million** tokens. `cache_read` matters more than anything else
in relay, because every session re-reads the same lens files and ledger.

| model         | id            | input (miss) | cache read | output | context | notes                          |
| ------------- | ------------- | -----------: | ---------: | -----: | ------: | ------------------------------ |
| Opus 5        | `opus-5`      |        15.00 |       1.50 |  75.00 |    200k | strongest reducer; costliest   |
| GPT‑5.6 Sol   | `gpt-5.6-sol` |         1.25 |       0.13 |  10.00 |    400k | best $/context for wide scans  |
| Kimi K3       | `kimi-k3`     |         0.60 |       0.06 |   2.50 |    256k | cheapest; good for extract     |
| Fable 5       | `fable-5`     |         3.00 |       0.30 |  15.00 |    200k | mid; good all-rounder          |

**These are placeholders you should verify.** Vendor prices move, and the exact
figures for these model names could not be confirmed at authoring time. They are
deliberately conservative (erring high) so a session under-spends rather than
over-spends. Two ways to correct them:

1. Edit the table above, or
2. Ignore it and let calibration take over — after two or three real units,
   `budget.js` prefers **observed** cost from `.relay/BUDGET.md` over the table.

Calibration always wins over the table when data exists. That is the intended
steady state.

## Blended cost

A session is not uniform: a scan unit is read-heavy, a reduce unit is
output-heavy. `budget.js` blends per **role**:

| role      | output share | cache hit rate | typical unit kinds        |
| --------- | -----------: | -------------: | ------------------------- |
| `read`    |         0.10 |           0.70 | `extract`, `map`          |
| `scan`    |         0.20 |           0.60 | `scan`, `seam`            |
| `write`   |         0.45 |           0.50 | `write`, `synthesize`     |
| `reduce`  |         0.60 |           0.40 | `reduce`                  |
| `build`   |         0.30 |           0.55 | `setup`, `loop`           |

Blended rate = `(1 − out_share) × (hit_rate × cache_read + (1 − hit_rate) × miss)
+ out_share × output`. Ceiling = `budget_usd ÷ blended_rate`, capped at 80% of the
model's context window so a single session can never plan to overflow context.

```bash
node relay/scripts/budget.js ceiling --model gpt-5.6-sol --usd 5 --role scan --root .
node relay/scripts/budget.js rates          # print the whole table
node relay/scripts/budget.js plan  --model opus-5 --usd 5 --root .   # units affordable
```

## The 75/25 split

| band     | allowed                                                   |
| -------- | --------------------------------------------------------- |
| 0–75%    | reading, analysis, tool calls, drafting findings           |
| 75–100%  | **reserve** — write findings, close unit, render, hand off |

The reserve exists because the failure mode that actually destroys work is running
out of room *while writing the result*. 25% of a $5 session is far more than one
findings file needs, which is the point: the write must never be the risky part.

Cross the 75% line and you stop analysing mid-thought. Do not "just finish this
one function". Record it as the remainder and let the next session start there
with a full budget.

## Measuring spend without a token counter

If the runtime does not expose token usage, count proxies and convert. Calibrate
by running `budget.js calibrate` on a couple of real units, after which the
observed numbers replace these:

| proxy                                     | rough tokens |
| ----------------------------------------- | -----------: |
| one source file read (~250 nSLOC)          |       ~4,000 |
| one lens file read                        |       ~1,200 |
| `shared-rules.md` + SOP                   |       ~2,500 |
| one Grep with ~40 hits                    |         ~800 |
| one written finding (full format)         |       ~1,000 |
| ledger + status + handoff overhead        |       ~2,000 |

Practical rule for a $5 session: **boot ≈ 2k, and the unit gets the rest.** If
you have read more than ~15 source files in one session, you are almost certainly
running a unit that should have been sharded smaller.

## Empirical calibration (recommended first run)

The runner's own suggestion, formalised — spend one cheap session measuring:

1. New chat, cheapest model, target repo, `--usd 5`.
2. Run exactly one `extract` unit. Nothing else.
3. `node relay/scripts/budget.js calibrate --root . --model <model> --unit <id> --tokens <used> --usd <observed>`
4. Repeat once for a `scan` unit and once for a `reduce` unit.

Three data points is enough to pin the curve, because the three roles bracket the
cost range. `.relay/BUDGET.md` then drives every later ceiling, and the table at
the top of this file becomes irrelevant. Cost per unit is roughly linear in shard
nSLOC, so one measurement generalises across shards of the same track.

## Model routing

All four models can run any unit. These are preferences, not requirements — relay
never blocks on model availability.

| unit kind               | prefer                | why                                        |
| ----------------------- | --------------------- | ------------------------------------------ |
| `map`, `extract`        | `kimi-k3`             | mechanical; cheapest wins                  |
| `scan` (specialty lens) | `opus-5` / `fable-5`  | adversarial depth is the whole value        |
| `seam` (gap-hunter)     | `opus-5`              | cross-shard reasoning is the hardest step   |
| `write`, `synthesize`   | `fable-5`             | structured output, moderate reasoning       |
| `setup`, `loop` (fizz)  | `gpt-5.6-sol`         | long compile/log context, cheap per token   |
| `reduce`                | `opus-5`              | the gates are unforgiving; do not economise |

Spend the budget where findings are *created* (`scan`, `seam`) and where they are
*judged* (`reduce`). Economise on mechanical units. The handoff prints the next
unit's suggested model so the runner knows which chat to open.
