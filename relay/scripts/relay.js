#!/usr/bin/env node
/**
 * relay.js — the baton.
 *
 * Owns `.relay/state.json` (canonical machine state) and renders
 * `.relay/LEDGER.md` (the human/LLM-readable view) from it after every mutation.
 *
 * Every write is atomic (tmp + rename) so a session that dies mid-write —
 * budget exhaustion, context blowout, disconnect — never corrupts the baton.
 *
 * Commands
 *   init          --track T --root R --model M [--budget 5] [--force]
 *   plan          --units <units.json> [--replace]
 *   next          [--n K] [--kind K] [--json]
 *   done          --id ID [--out PATH] [--notes "..."]
 *   split         --id ID --remainder "what is left" [--out PATH] [--notes "..."]
 *   block         --id ID --reason "..."
 *   requeue       --id ID
 *   recover
 *   session-start --model M [--ceiling N]
 *   session-end   [--tokens N] [--usd U] [--reason R]
 *   status        [--json]
 *   set-meta      --key K --value V
 *   render
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 'relay-state-v1';
const STATES = ['queued', 'in_flight', 'done', 'split', 'blocked'];

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function die(msg) {
  process.stderr.write(`relay: ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------- io --- */

function relayDir(root) {
  return path.join(root, '.relay');
}

function statePath(root) {
  return path.join(relayDir(root), 'state.json');
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadState(root) {
  const p = statePath(root);
  if (!fs.existsSync(p)) {
    die(`no ledger at ${p} — run "relay.js init" first`);
  }
  const st = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (st.schema !== SCHEMA) {
    die(`ledger schema is "${st.schema}", this script speaks "${SCHEMA}"`);
  }
  return st;
}

function saveState(root, st) {
  st.updated = new Date().toISOString();
  writeAtomic(statePath(root), `${JSON.stringify(st, null, 2)}\n`);
  writeAtomic(path.join(relayDir(root), 'LEDGER.md'), renderLedger(st));
}

function resolveRoot(args) {
  const root = path.resolve(args.root || process.cwd());
  if (!fs.existsSync(root)) die(`root does not exist: ${root}`);
  return root;
}

/* ---------------------------------------------------------------- helpers - */

function findUnit(st, id) {
  const u = st.units.find((x) => x.id === id);
  if (!u) die(`no unit with id "${id}"`);
  return u;
}

function depsSatisfied(st, unit) {
  if (!unit.deps || unit.deps.length === 0) return true;
  return unit.deps.every((d) => {
    const dep = st.units.find((x) => x.id === d);
    return dep && dep.state === 'done';
  });
}

function currentSession(st) {
  if (st.sessions.length === 0) return null;
  const last = st.sessions[st.sessions.length - 1];
  return last.ended ? null : last;
}

function counts(st) {
  const c = { total: st.units.length };
  for (const s of STATES) c[s] = st.units.filter((u) => u.state === s).length;
  return c;
}

function pct(n, d) {
  if (!d) return '0%';
  return `${Math.round((n / d) * 100)}%`;
}

/* ----------------------------------------------------------------- render - */

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function renderLedger(st) {
  const c = counts(st);
  const L = [];

  L.push('---');
  L.push(`schema: ${st.schema}`);
  L.push(`track: ${st.track}`);
  L.push(`project_root: ${st.root}`);
  L.push(`budget_usd_per_session: ${st.budget_usd}`);
  L.push(`created: ${st.created}`);
  L.push(`updated: ${st.updated || st.created}`);
  L.push(`status: ${st.status}`);
  L.push('---');
  L.push('');
  L.push(`# Relay Ledger — \`${st.track}\``);
  L.push('');
  L.push('> This file is GENERATED from `.relay/state.json`. Do not hand-edit —');
  L.push('> edit via `relay.js` commands, or edit `state.json` then run `relay.js render`.');
  L.push('');
  L.push(
    `**Progress:** ${c.done}/${c.total} units done (${pct(c.done, c.total)}) · ` +
      `${c.queued} queued · ${c.in_flight} in flight · ${c.split} split · ${c.blocked} blocked`
  );
  L.push('');

  /* --- resume instruction: the single most important line in the file --- */
  L.push('## Resume');
  L.push('');
  if (st.status === 'done') {
    L.push('All units complete. Nothing to resume.');
  } else {
    const inFlight = st.units.filter((u) => u.state === 'in_flight');
    if (inFlight.length) {
      L.push(
        '⚠️  Units are marked `in_flight` — the previous session ended without ' +
          'closing them. Run `relay.js recover` at the START of the next session ' +
          'before claiming new work.'
      );
      L.push('');
    }
    L.push('In a fresh session, say:');
    L.push('');
    L.push('```');
    L.push(`relay resume ${st.root}`);
    L.push('```');
    L.push('');
    L.push('The skill will read this ledger, `MAP.md`, and `CARRY.md`, then claim the next units.');
  }
  L.push('');

  /* --- sessions --- */
  L.push('## Sessions');
  L.push('');
  if (st.sessions.length === 0) {
    L.push('_none yet_');
  } else {
    L.push('| # | model | started | ended | tokens | est. $ | units closed | end reason |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const s of st.sessions) {
      L.push(
        `| ${s.n} | ${esc(s.model)} | ${esc(s.started)} | ${esc(s.ended || '—')} | ` +
          `${s.tokens != null ? s.tokens : '—'} | ${s.usd != null ? s.usd : '—'} | ` +
          `${esc((s.units || []).join(', ') || '—')} | ${esc(s.end_reason || '—')} |`
      );
    }
  }
  L.push('');

  /* --- queue --- */
  L.push('## Work units');
  L.push('');
  L.push('| id | pri | kind | lens / step | shard | state | deps | output | notes |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  const order = { in_flight: 0, queued: 1, split: 2, blocked: 3, done: 4 };
  const sorted = [...st.units].sort(
    (a, b) => (order[a.state] - order[b.state]) || (b.pri - a.pri) || a.id.localeCompare(b.id)
  );
  for (const u of sorted) {
    L.push(
      `| \`${esc(u.id)}\` | ${u.pri} | ${esc(u.kind)} | ${esc(u.lens || u.step || '')} | ` +
        `${esc(u.shard || '')} | ${esc(u.state)} | ${esc((u.deps || []).join(' '))} | ` +
        `${u.out ? `\`${esc(u.out)}\`` : ''} | ${esc(u.notes)} |`
    );
  }
  L.push('');

  /* --- split remainders need loud visibility --- */
  const splits = st.units.filter((u) => u.state === 'split' && u.remainder);
  if (splits.length) {
    L.push('## Split remainders (unfinished work, re-queued as new units)');
    L.push('');
    for (const u of splits) {
      L.push(`- \`${esc(u.id)}\` → ${esc(u.remainder)}`);
    }
    L.push('');
  }

  const blocked = st.units.filter((u) => u.state === 'blocked');
  if (blocked.length) {
    L.push('## Blocked');
    L.push('');
    for (const u of blocked) {
      L.push(`- \`${esc(u.id)}\` — ${esc(u.notes || 'no reason recorded')}`);
    }
    L.push('');
  }

  if (Object.keys(st.meta || {}).length) {
    L.push('## Meta');
    L.push('');
    for (const [k, v] of Object.entries(st.meta)) {
      L.push(`- **${esc(k)}**: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`);
    }
    L.push('');
  }

  return `${L.join('\n')}\n`;
}

/* ---------------------------------------------------------------- commands */

function cmdInit(args) {
  const root = resolveRoot(args);
  if (!args.track) die('--track is required (solidity-auditor | x-ray | fizz)');
  const p = statePath(root);
  if (fs.existsSync(p) && !args.force) {
    const st = loadState(root);
    process.stdout.write(
      `ledger already exists (track=${st.track}, ${counts(st).done}/${st.units.length} done). ` +
        `Use --force to wipe, or just resume.\n`
    );
    return;
  }
  const st = {
    schema: SCHEMA,
    track: String(args.track),
    root,
    budget_usd: Number(args.budget || 5),
    created: new Date().toISOString(),
    status: 'in_progress',
    units: [],
    sessions: [],
    meta: {},
  };
  if (args.model) st.meta.boot_model = String(args.model);

  for (const d of ['findings', 'units', 'facts']) {
    fs.mkdirSync(path.join(relayDir(root), d), { recursive: true });
  }
  saveState(root, st);
  process.stdout.write(`initialised ${p}\n`);
}

function cmdPlan(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  if (!args.units) die('--units <units.json> is required');
  const raw = JSON.parse(fs.readFileSync(path.resolve(String(args.units)), 'utf8'));
  const incoming = Array.isArray(raw) ? raw : raw.units;
  if (!Array.isArray(incoming)) die('units file must be an array, or {"units": [...]}');

  if (args.replace) st.units = [];
  const seen = new Set(st.units.map((u) => u.id));
  let added = 0;
  for (const u of incoming) {
    if (!u.id) die('every unit needs an "id"');
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    st.units.push({
      id: String(u.id),
      pri: Number(u.pri != null ? u.pri : 50),
      kind: String(u.kind || 'work'),
      lens: u.lens || null,
      step: u.step || null,
      shard: u.shard || null,
      files: u.files || [],
      deps: u.deps || [],
      est_tokens: u.est_tokens || null,
      state: 'queued',
      out: null,
      notes: u.notes || '',
      remainder: null,
      attempts: 0,
    });
    added++;
  }
  saveState(root, st);
  process.stdout.write(`planned ${added} new unit(s); ${st.units.length} total\n`);
}

function cmdNext(args) {
  const root = resolveRoot(args);
  const st = loadState(root);

  const stale = st.units.filter((u) => u.state === 'in_flight');
  if (stale.length) {
    die(
      `${stale.length} unit(s) still in_flight (${stale.map((u) => u.id).join(', ')}). ` +
        `Run "relay.js recover" first.`
    );
  }

  const n = Number(args.n || 1);
  const eligible = st.units
    .filter((u) => u.state === 'queued')
    .filter((u) => (args.kind ? u.kind === args.kind : true))
    .filter((u) => depsSatisfied(st, u))
    .sort((a, b) => (b.pri - a.pri) || a.id.localeCompare(b.id));

  const claimed = eligible.slice(0, n);
  if (claimed.length === 0) {
    const anyQueued = st.units.some((u) => u.state === 'queued');
    if (!anyQueued) {
      st.status = 'done';
      saveState(root, st);
      process.stdout.write('NO_UNITS_LEFT — all work complete. Run the REDUCE unit if the track has one.\n');
    } else {
      process.stdout.write('NO_ELIGIBLE_UNITS — remaining units are blocked on unmet deps.\n');
    }
    return;
  }

  const sess = currentSession(st);
  for (const u of claimed) {
    u.state = 'in_flight';
    u.attempts = (u.attempts || 0) + 1;
    if (sess) {
      sess.units = sess.units || [];
      if (!sess.units.includes(u.id)) sess.units.push(u.id);
    }
  }
  saveState(root, st);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(claimed, null, 2)}\n`);
    return;
  }
  for (const u of claimed) {
    process.stdout.write(
      `CLAIMED ${u.id} | kind=${u.kind} | lens=${u.lens || u.step || '-'} | shard=${u.shard || '-'} | ` +
        `files=${(u.files || []).length} | attempt=${u.attempts}\n`
    );
    for (const f of u.files || []) process.stdout.write(`  file: ${f}\n`);
    if (u.notes) process.stdout.write(`  notes: ${u.notes}\n`);
  }
}

function cmdDone(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const u = findUnit(st, String(args.id));
  u.state = 'done';
  u.remainder = null;
  if (args.out) u.out = String(args.out);
  if (args.notes) u.notes = String(args.notes);
  if (st.units.every((x) => x.state === 'done')) st.status = 'done';
  saveState(root, st);
  process.stdout.write(`done ${u.id} (${counts(st).done}/${st.units.length})\n`);
}

function cmdSplit(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const u = findUnit(st, String(args.id));
  if (!args.remainder) die('--remainder "what is left" is required for split');
  u.state = 'split';
  u.remainder = String(args.remainder);
  if (args.out) u.out = String(args.out);
  if (args.notes) u.notes = String(args.notes);

  // The remainder becomes a real, claimable unit so nothing is silently lost.
  const base = `${u.id}-r`;
  let k = 1;
  while (st.units.some((x) => x.id === `${base}${k}`)) k++;
  st.units.push({
    id: `${base}${k}`,
    pri: u.pri + 1, // finish what we started before opening new fronts
    kind: u.kind,
    lens: u.lens,
    step: u.step,
    shard: u.shard,
    files: u.files || [],
    deps: u.deps || [],
    est_tokens: u.est_tokens || null,
    state: 'queued',
    out: null,
    notes: `remainder of ${u.id}: ${u.remainder}`,
    remainder: null,
    attempts: 0,
  });
  saveState(root, st);
  process.stdout.write(`split ${u.id} → queued ${base}${k}\n`);
}

function cmdBlock(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const u = findUnit(st, String(args.id));
  u.state = 'blocked';
  u.notes = String(args.reason || args.notes || u.notes || 'blocked');
  saveState(root, st);
  process.stdout.write(`blocked ${u.id}: ${u.notes}\n`);
}

function cmdRequeue(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const u = findUnit(st, String(args.id));
  u.state = 'queued';
  saveState(root, st);
  process.stdout.write(`requeued ${u.id}\n`);
}

function cmdRecover(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const stale = st.units.filter((u) => u.state === 'in_flight');
  if (stale.length === 0) {
    process.stdout.write('nothing to recover\n');
    return;
  }
  for (const u of stale) {
    // If the unit already produced partial output, keep it and re-queue so the
    // next session can extend rather than redo. Otherwise straight re-queue.
    const outPath = u.out ? path.resolve(root, u.out) : null;
    const hasPartial = outPath && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    u.state = 'queued';
    u.notes = hasPartial
      ? `RECOVERED with partial output at ${u.out} — extend it, do not restart from zero. ${u.notes || ''}`.trim()
      : `RECOVERED after an aborted session (attempt ${u.attempts}). ${u.notes || ''}`.trim();
  }
  const sess = currentSession(st);
  if (sess) {
    sess.ended = new Date().toISOString();
    sess.end_reason = sess.end_reason || 'aborted (recovered by next session)';
  }
  saveState(root, st);
  process.stdout.write(`recovered ${stale.length} unit(s): ${stale.map((u) => u.id).join(', ')}\n`);
}

function cmdSessionStart(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const open = currentSession(st);
  if (open) {
    process.stdout.write(
      `session ${open.n} is still open (started ${open.started}). ` +
        `Closing it as aborted before opening a new one.\n`
    );
    open.ended = new Date().toISOString();
    open.end_reason = open.end_reason || 'aborted';
  }
  const n = st.sessions.length + 1;
  st.sessions.push({
    n,
    model: String(args.model || 'unknown'),
    ceiling: args.ceiling ? Number(args.ceiling) : null,
    started: new Date().toISOString(),
    ended: null,
    tokens: null,
    usd: null,
    end_reason: null,
    units: [],
  });
  saveState(root, st);
  process.stdout.write(`session ${n} open (model=${args.model || 'unknown'})\n`);
}

function cmdSessionEnd(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const sess = currentSession(st);
  if (!sess) {
    process.stdout.write('no open session\n');
    return;
  }
  sess.ended = new Date().toISOString();
  if (args.tokens) sess.tokens = Number(args.tokens);
  if (args.usd) sess.usd = Number(args.usd);
  sess.end_reason = String(args.reason || 'checkpoint');
  saveState(root, st);
  process.stdout.write(`session ${sess.n} closed (${sess.end_reason})\n`);
}

function cmdStatus(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  const c = counts(st);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ track: st.track, status: st.status, counts: c, units: st.units }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`track:    ${st.track}\n`);
  process.stdout.write(`status:   ${st.status}\n`);
  process.stdout.write(`progress: ${c.done}/${c.total} (${pct(c.done, c.total)})\n`);
  process.stdout.write(`queued=${c.queued} in_flight=${c.in_flight} split=${c.split} blocked=${c.blocked}\n`);
  process.stdout.write(`sessions: ${st.sessions.length}\n`);
  const nextUp = st.units
    .filter((u) => u.state === 'queued' && depsSatisfied(st, u))
    .sort((a, b) => (b.pri - a.pri) || a.id.localeCompare(b.id))
    .slice(0, 5);
  if (nextUp.length) {
    process.stdout.write('next up:\n');
    for (const u of nextUp) {
      process.stdout.write(`  ${u.id} (pri ${u.pri}, ${u.lens || u.step || u.kind})\n`);
    }
  }
}

function cmdSetMeta(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  if (!args.key) die('--key is required');
  st.meta = st.meta || {};
  st.meta[String(args.key)] = args.value === undefined ? true : args.value;
  saveState(root, st);
  process.stdout.write(`meta.${args.key} = ${st.meta[String(args.key)]}\n`);
}

function cmdRender(args) {
  const root = resolveRoot(args);
  const st = loadState(root);
  saveState(root, st);
  process.stdout.write(`rendered ${path.join(relayDir(root), 'LEDGER.md')}\n`);
}

/* -------------------------------------------------------------------- main */

const COMMANDS = {
  init: cmdInit,
  plan: cmdPlan,
  next: cmdNext,
  done: cmdDone,
  split: cmdSplit,
  block: cmdBlock,
  requeue: cmdRequeue,
  recover: cmdRecover,
  'session-start': cmdSessionStart,
  'session-end': cmdSessionEnd,
  status: cmdStatus,
  'set-meta': cmdSetMeta,
  render: cmdRender,
};

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || !COMMANDS[cmd]) {
    process.stdout.write(
      `usage: relay.js <command> [options]\n\ncommands:\n  ${Object.keys(COMMANDS).join('\n  ')}\n`
    );
    process.exit(cmd && !COMMANDS[cmd] ? 1 : 0);
  }
  COMMANDS[cmd](parseArgs(argv.slice(1)));
}

main();
