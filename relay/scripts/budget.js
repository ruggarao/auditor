#!/usr/bin/env node
/**
 * budget.js — converts "$5 per session" into hard, checkable numbers.
 *
 * The real constraint is tokens; dollars are just tokens times a rate. This
 * script does that conversion, applies the 75% hard-checkpoint reserve, and
 * tells the session how many work units it may claim.
 *
 * It also self-calibrates: `calibrate` records what a real session actually
 * cost, and later `ceiling` calls prefer the measured blended rate over the
 * published-price model. Measured beats modelled, always.
 *
 * Commands
 *   ceiling   --model M [--usd 5] [--role read|write|mech] [--root R] [--json]
 *   plan      --model M --unit-loc N [--role R] [--usd 5] [--root R] [--json]
 *   calibrate --model M --tokens N [--usd U] [--root R] [--note "..."]
 *   rates     [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* --------------------------------------------------------------- rate card */
/* Published list prices, USD per 1M tokens. Verified 2026-07-31.            */
/* `miss` is what a cache-miss input token really costs in an agentic loop:  */
/* where a provider charges separately to WRITE the cache, that write price  */
/* is the honest miss price, because a long session writes the cache once    */
/* per growing prefix. Where no write price exists, miss = plain input.      */

const MODELS = {
  'opus-5': {
    label: 'Claude Opus 5',
    ctx: 1000000,
    input: 5.0,
    output: 25.0,
    cache_read: 0.5,
    miss: 6.25, // 5-min cache write
    per_request_cap: null, // no long-context surcharge
    notes: 'No long-context surcharge. Batch API halves rates.',
  },
  'gpt-5.6-sol': {
    label: 'GPT-5.6 Sol',
    ctx: 1050000,
    input: 5.0,
    output: 30.0,
    cache_read: 0.5,
    miss: 5.0,
    per_request_cap: 272000, // CROSSING THIS DOUBLES INPUT AND RAISES OUTPUT 50%
    tier2: { input: 10.0, output: 45.0, cache_read: 1.0, miss: 12.5 },
    notes: 'HARD RULE: keep every single request under 272k tokens or the rate doubles.',
  },
  'kimi-k3': {
    label: 'Kimi K3',
    ctx: 1048576,
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    miss: 3.0,
    per_request_cap: null,
    reasoning_always_on: true,
    notes: 'Reasoning is always on — output share runs high. Cheapest per token.',
  },
  'fable-5': {
    label: 'Claude Fable 5',
    ctx: 1000000,
    input: 10.0,
    output: 50.0,
    cache_read: 1.0,
    miss: 10.0,
    per_request_cap: null,
    notes: 'Most expensive per token — smallest session budget. Batch API halves rates.',
  },
};

const ALIASES = {
  opus: 'opus-5',
  opus5: 'opus-5',
  'claude-opus-5': 'opus-5',
  sol: 'gpt-5.6-sol',
  gpt56: 'gpt-5.6-sol',
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt5.6-sol': 'gpt-5.6-sol',
  k3: 'kimi-k3',
  kimi: 'kimi-k3',
  kimik3: 'kimi-k3',
  fable: 'fable-5',
  fable5: 'fable-5',
  'claude-fable-5': 'fable-5',
};

/* ------------------------------------------------------------- role shapes */
/* How a session's tokens split, by the kind of work it is doing.            */
/*  out_share — fraction of billed tokens that are output                    */
/*  hit_rate  — fraction of input tokens served from cache                   */
/*  resend    — how many times the loaded source is effectively re-billed    */
/*  loc_cap   — attention ceiling, in nSLOC, independent of money            */

const ROLES = {
  // Deep adversarial reading: one lens, one shard, many re-reads.
  read: { out_share: 0.15, hit_rate: 0.7, resend: 6, loc_cap: 2500, label: 'adversarial read' },
  // Mechanical fact extraction: signatures, deltas, guards. Low reasoning.
  mech: { out_share: 0.1, hit_rate: 0.75, resend: 3, loc_cap: 4000, label: 'mechanical extraction' },
  // Code generation / editing: handlers, properties, report writing.
  write: { out_share: 0.3, hit_rate: 0.65, resend: 4, loc_cap: 2000, label: 'generate / edit' },
  // Reduce: dedup, gating, assembly. Operates on compact findings, not source.
  reduce: { out_share: 0.35, hit_rate: 0.6, resend: 2, loc_cap: 0, label: 'reduce / assemble' },
};

const TOKENS_PER_LOC = 14; // Solidity, including comments and whitespace
const CHECKPOINT = 0.75; // hard stop; last 25% is reserved for the handoff
const SESSION_OVERHEAD = 40000; // skill text, ledger, MAP, CARRY, tool chatter

/* ------------------------------------------------------------------- args  */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) out[k] = true;
      else {
        out[k] = n;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function die(m) {
  process.stderr.write(`budget: ${m}\n`);
  process.exit(1);
}

function resolveModel(name) {
  if (!name || name === true) die('--model is required (opus-5 | gpt-5.6-sol | kimi-k3 | fable-5)');
  const key = String(name).toLowerCase();
  const id = MODELS[key] ? key : ALIASES[key];
  if (!id) die(`unknown model "${name}". Known: ${Object.keys(MODELS).join(', ')}, ${Object.keys(ALIASES).join(', ')}`);
  return { id, m: MODELS[id] };
}

function resolveRole(name) {
  const key = String(name || 'read').toLowerCase();
  if (!ROLES[key]) die(`unknown role "${name}". Known: ${Object.keys(ROLES).join(', ')}`);
  return { id: key, r: ROLES[key] };
}

/* --------------------------------------------------------------- the model */

function blendedRate(m, r) {
  const inShare = 1 - r.out_share;
  const inRate = r.hit_rate * m.cache_read + (1 - r.hit_rate) * m.miss;
  return inShare * inRate + r.out_share * m.output;
}

function calibPath(root) {
  return path.join(root, '.relay', 'BUDGET.md');
}

function readCalibration(root, modelId) {
  if (!root) return null;
  const p = calibPath(root);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const rows = [];
  // | model | tokens | usd | $/Mtok | when | note |
  const re = /^\|\s*([A-Za-z0-9.\-]+)\s*\|\s*([0-9]+)\s*\|\s*([0-9.]+)\s*\|/gm;
  let mm;
  while ((mm = re.exec(text)) !== null) {
    if (mm[1].toLowerCase() !== modelId) continue;
    const tokens = Number(mm[2]);
    const usd = Number(mm[3]);
    if (tokens > 0 && usd > 0) rows.push((usd / tokens) * 1e6);
  }
  if (rows.length === 0) return null;
  // Trust recent observations more: simple weighted mean, newest weighted 2x.
  let num = 0;
  let den = 0;
  rows.forEach((rate, i) => {
    const w = 1 + i / Math.max(1, rows.length - 1);
    num += rate * w;
    den += w;
  });
  return { rate: num / den, samples: rows.length };
}

function computeCeiling(modelId, m, roleId, r, usd, root) {
  const modelled = blendedRate(m, r);
  const cal = readCalibration(root, modelId);
  const rate = cal ? cal.rate : modelled;
  const total = Math.floor((usd / rate) * 1e6);
  const working = Math.floor(total * CHECKPOINT);
  const perRequest = m.per_request_cap;
  const unitCost = (loc) => Math.round(loc * TOKENS_PER_LOC * r.resend);
  const locCap = r.loc_cap;
  const budgetLoc = locCap ? Math.floor((working - SESSION_OVERHEAD) / (TOKENS_PER_LOC * r.resend)) : 0;
  const effectiveLoc = locCap ? Math.min(locCap, Math.max(0, budgetLoc)) : 0;
  const unitsPerSession = locCap
    ? Math.max(1, Math.floor((working - SESSION_OVERHEAD) / Math.max(1, unitCost(effectiveLoc))))
    : 1;

  return {
    model: modelId,
    model_label: m.label,
    role: roleId,
    role_label: r.label,
    usd_budget: usd,
    rate_source: cal ? `calibrated (${cal.samples} sample${cal.samples > 1 ? 's' : ''})` : 'modelled from list price',
    blended_usd_per_mtok: Number(rate.toFixed(2)),
    modelled_usd_per_mtok: Number(modelled.toFixed(2)),
    total_token_ceiling: total,
    working_token_ceiling: working,
    reserve_tokens: total - working,
    checkpoint_at_pct: Math.round(CHECKPOINT * 100),
    per_request_cap: perRequest,
    session_overhead_tokens: SESSION_OVERHEAD,
    shard_loc_cap: locCap,
    shard_loc_budget_derived: budgetLoc,
    shard_loc_recommended: effectiveLoc,
    est_tokens_per_unit: locCap ? unitCost(effectiveLoc) : working - SESSION_OVERHEAD,
    units_per_session: unitsPerSession,
    warnings: warningsFor(m, r),
  };
}

function warningsFor(m, r) {
  const w = [];
  if (m.per_request_cap) {
    w.push(
      `HARD: keep every request under ${m.per_request_cap.toLocaleString()} tokens. ` +
        `Above it this model charges ${m.tier2.input}/${m.tier2.output} per Mtok instead of ` +
        `${m.input}/${m.output} — roughly double. Never load a shard that pushes you over.`
    );
  }
  if (m.reasoning_always_on) {
    w.push(
      'Reasoning cannot be disabled on this model, so output share runs high. ' +
        'Keep mechanical units terse: extract, do not deliberate.'
    );
  }
  if (m.notes) w.push(m.notes);
  if (r.loc_cap && r.loc_cap <= 2500) {
    w.push(
      `Shard cap of ${r.loc_cap} nSLOC is an ATTENTION limit, not a money limit. ` +
        'Do not raise it just because budget remains — split into more units instead.'
    );
  }
  return w;
}

/* ---------------------------------------------------------------- commands */

function printCeiling(c, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(c, null, 2)}\n`);
    return;
  }
  const L = [];
  L.push(`model            ${c.model_label} (${c.model})`);
  L.push(`role             ${c.role_label} (${c.role})`);
  L.push(`budget           $${c.usd_budget} per session`);
  L.push(`blended rate     $${c.blended_usd_per_mtok}/Mtok — ${c.rate_source}`);
  if (c.rate_source !== 'modelled from list price') {
    L.push(`                 (list-price model said $${c.modelled_usd_per_mtok}/Mtok)`);
  }
  L.push('');
  L.push(`TOTAL CEILING    ${c.total_token_ceiling.toLocaleString()} tokens`);
  L.push(`WORK CEILING     ${c.working_token_ceiling.toLocaleString()} tokens  <-- hard checkpoint at ${c.checkpoint_at_pct}%`);
  L.push(`HANDOFF RESERVE  ${c.reserve_tokens.toLocaleString()} tokens  (never spend this on analysis)`);
  if (c.per_request_cap) {
    L.push(`PER-REQUEST CAP  ${c.per_request_cap.toLocaleString()} tokens  <-- price doubles above this`);
  }
  L.push('');
  if (c.shard_loc_cap) {
    L.push(`shard size       ${c.shard_loc_recommended} nSLOC recommended`);
    L.push(`                 (attention cap ${c.shard_loc_cap}, budget allows ${c.shard_loc_budget_derived})`);
    L.push(`cost per unit    ~${c.est_tokens_per_unit.toLocaleString()} tokens`);
  }
  L.push(`UNITS THIS RUN   ${c.units_per_session}   <-- claim exactly this many, no more`);
  if (c.warnings.length) {
    L.push('');
    L.push('warnings:');
    for (const w of c.warnings) L.push(`  - ${w}`);
  }
  process.stdout.write(`${L.join('\n')}\n`);
}

function cmdCeiling(args) {
  const { id, m } = resolveModel(args.model);
  const { id: roleId, r } = resolveRole(args.role);
  const usd = Number(args.usd || 5);
  const root = args.root ? path.resolve(String(args.root)) : null;
  printCeiling(computeCeiling(id, m, roleId, r, usd, root), args.json);
}

function cmdPlan(args) {
  const { id, m } = resolveModel(args.model);
  const { id: roleId, r } = resolveRole(args.role);
  const usd = Number(args.usd || 5);
  const root = args.root ? path.resolve(String(args.root)) : null;
  const loc = Number(args.unitLoc || args['unit-loc'] || 0);
  if (!loc) die('--unit-loc N is required for plan');
  const c = computeCeiling(id, m, roleId, r, usd, root);
  const perUnit = Math.round(loc * TOKENS_PER_LOC * r.resend);
  const fits = Math.max(0, Math.floor((c.working_token_ceiling - SESSION_OVERHEAD) / Math.max(1, perUnit)));
  const requestTokens = Math.round(loc * TOKENS_PER_LOC) + SESSION_OVERHEAD;
  const over = m.per_request_cap && requestTokens > m.per_request_cap;
  const out = {
    ...c,
    asked_unit_loc: loc,
    est_tokens_per_unit: perUnit,
    units_that_fit: fits,
    peak_request_tokens: requestTokens,
    exceeds_per_request_cap: !!over,
    verdict: fits === 0 ? 'SPLIT_REQUIRED' : over ? 'SPLIT_REQUIRED_PRICE_TIER' : 'OK',
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  printCeiling(c, false);
  process.stdout.write('\n');
  process.stdout.write(`asked shard      ${loc} nSLOC → ~${perUnit.toLocaleString()} tokens/unit\n`);
  process.stdout.write(`units that fit   ${fits}\n`);
  process.stdout.write(`peak request     ~${requestTokens.toLocaleString()} tokens\n`);
  process.stdout.write(`VERDICT          ${out.verdict}\n`);
  if (out.verdict !== 'OK') {
    const target = m.per_request_cap
      ? Math.floor((m.per_request_cap - SESSION_OVERHEAD) / TOKENS_PER_LOC)
      : c.shard_loc_recommended;
    process.stdout.write(`                 resize shards to <= ${Math.max(200, Math.min(target, c.shard_loc_recommended))} nSLOC\n`);
  }
}

function cmdCalibrate(args) {
  const { id } = resolveModel(args.model);
  const root = path.resolve(String(args.root || process.cwd()));
  const tokens = Number(args.tokens || 0);
  if (!tokens) die('--tokens N is required');
  const usd = args.usd ? Number(args.usd) : null;
  const p = calibPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  if (!fs.existsSync(p)) {
    const header = [
      '# Relay Budget Calibration',
      '',
      'Measured cost of real sessions. `budget.js ceiling` prefers these rows over',
      'its list-price model, weighting newer rows more heavily. Newest row last.',
      '',
      'To add a row by hand, keep the column order exactly as below.',
      '',
      '| model | tokens | usd | $/Mtok | when | note |',
      '|---|---|---|---|---|---|',
      '',
    ].join('\n');
    fs.writeFileSync(p, header);
  }

  const rate = usd ? ((usd / tokens) * 1e6).toFixed(2) : '—';
  const row =
    `| ${id} | ${tokens} | ${usd != null ? usd : '—'} | ${rate} | ` +
    `${new Date().toISOString()} | ${String(args.note || '').replace(/\|/g, '/')} |\n`;

  let text = fs.readFileSync(p, 'utf8');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(p, text + row);
  process.stdout.write(`calibrated: ${id} ${tokens} tokens${usd != null ? ` = $${usd} → $${rate}/Mtok` : ''}\n`);
  process.stdout.write(`recorded in ${p}\n`);
}

function cmdRates(args) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ models: MODELS, roles: ROLES }, null, 2)}\n`);
    return;
  }
  process.stdout.write('Published rates, USD per 1M tokens (verified 2026-07-31)\n\n');
  process.stdout.write('| model | ctx | in | out | cache read | miss used | per-request cap |\n');
  process.stdout.write('|---|---|---|---|---|---|---|\n');
  for (const [id, m] of Object.entries(MODELS)) {
    process.stdout.write(
      `| ${id} | ${(m.ctx / 1000).toFixed(0)}k | ${m.input} | ${m.output} | ${m.cache_read} | ` +
        `${m.miss} | ${m.per_request_cap ? `${(m.per_request_cap / 1000).toFixed(0)}k` : '—'} |\n`
    );
  }
  process.stdout.write('\n$5 session ceilings by role (modelled, uncalibrated):\n\n');
  process.stdout.write('| model | role | blended $/Mtok | total | working (75%) | units |\n');
  process.stdout.write('|---|---|---|---|---|---|\n');
  for (const [id, m] of Object.entries(MODELS)) {
    for (const [rid, r] of Object.entries(ROLES)) {
      const c = computeCeiling(id, m, rid, r, 5, null);
      process.stdout.write(
        `| ${id} | ${rid} | ${c.blended_usd_per_mtok} | ${c.total_token_ceiling.toLocaleString()} | ` +
          `${c.working_token_ceiling.toLocaleString()} | ${c.units_per_session} |\n`
      );
    }
  }
}

const COMMANDS = { ceiling: cmdCeiling, plan: cmdPlan, calibrate: cmdCalibrate, rates: cmdRates };

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || !COMMANDS[cmd]) {
    process.stdout.write(`usage: budget.js <${Object.keys(COMMANDS).join('|')}> [options]\n`);
    process.exit(cmd ? 1 : 0);
  }
  COMMANDS[cmd](parseArgs(argv.slice(1)));
}

main();
