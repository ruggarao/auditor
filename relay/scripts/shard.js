#!/usr/bin/env node
/**
 * shard.js — cuts a Solidity codebase into attention-sized shards, measures
 * each shard's traits, and expands (lens x shard) into a PRIORITISED unit queue.
 *
 * Why traits matter: the full skills run every lens over every file. At 50k
 * nSLOC that is not a budget problem, it is an impossibility. So instead of
 * dropping lenses (which would lose capability) we ROUTE them: each lens keeps
 * its full instruction file and runs where its trait signal is strongest, and
 * every lens additionally gets a cross-shard SEAM unit that reads the digest
 * instead of raw source. Nothing is deleted; only the order changes.
 *
 * Commands
 *   scan   --root R [--src S] [--loc N] [--out .relay/shards.json] [--json]
 *   units  --shards .relay/shards.json --track T [--out .relay/units.json]
 *          [--max-units N] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
  process.stderr.write(`shard: ${m}\n`);
  process.exit(1);
}

/* ------------------------------------------------------- scope + measuring */

/* Mirrors the exclude rules of the full skills exactly. */
const EXCLUDE_DIR = /(^|\/)(node_modules|lib|libs|out|cache|artifacts|broadcast|\.git|test|tests|mocks?|mock|interfaces|script|scripts|x-ray|\.relay)(\/|$)/;
const EXCLUDE_FILE = /(\.t\.sol$|\.tree$|Test.*\.sol$|.*Test\.sol$|Mock.*\.sol$|.*Mock\.sol$|^I[A-Z].*\.sol$)/;

function walk(dir, acc, rootLen) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = full.slice(rootLen).replace(/^\//, '');
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.test(`/${rel}/`)) continue;
      walk(full, acc, rootLen);
    } else if (e.isFile() && e.name.endsWith('.sol')) {
      if (EXCLUDE_FILE.test(e.name)) continue;
      if (EXCLUDE_DIR.test(`/${rel}`)) continue;
      acc.push(rel);
    }
  }
  return acc;
}

/* nSLOC: non-blank, non-comment-only lines. Same spirit as x-ray's enumerate. */
function measure(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  let nsloc = 0;
  let inBlock = false;
  for (let raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    nsloc++;
  }

  const count = (re) => (text.match(re) || []).length;

  return {
    nsloc,
    traits: {
      // math-precision / numerical-gap / roundtrip signal
      arith: count(/[*/]\s*(?:10\s*\*\*|1e|[A-Za-z_][A-Za-z0-9_]*)|mulDiv|FullMath|WAD|RAY|PRECISION|1e18|<<|>>/g),
      // access-control / trust-gap signal
      access: count(/onlyOwner|onlyRole|onlyAdmin|onlyKeeper|only[A-Z][A-Za-z]*|_checkRole|hasRole|require\s*\(\s*msg\.sender/g),
      // execution-trace / flow-gap / periphery signal
      external: count(/\.\s*(call|delegatecall|staticcall|transfer|transferFrom|safeTransfer|safeTransferFrom)\s*\(|IERC20|interface\s+I/g),
      // economic-security signal
      value: count(/balanceOf|totalSupply|totalAssets|totalBorrows|reserve|collateral|debt|shares|liquidity|price|oracle|fee/gi),
      // invariant / conservation signal
      aggregate: count(/\b(total[A-Z][A-Za-z]*|sum[A-Z][A-Za-z]*|accumulated[A-Z][A-Za-z]*)\b/g),
      // boundary signal
      bounds: count(/require\s*\(|revert\s|assert\s*\(|<=|>=|type\s*\(\s*uint/g),
      // asymmetry signal: paired operations living together
      paired: count(/\b(deposit|withdraw|mint|burn|stake|unstake|borrow|repay|lock|unlock|open|close|join|exit|add|remove)\b/gi),
      // state machine / first-principles signal
      state: count(/enum\s+|=\s*Status\.|initializer|reinitializer|paused|whenNotPaused|block\.(timestamp|number)/g),
      // surface size
      entrypoints: count(/function\s+[A-Za-z0-9_]+\s*\([^)]*\)[^{;]*\b(external|public)\b/g),
      assembly: count(/assembly\s*\{/g),
      upgradeable: count(/Upgradeable|__gap|_disableInitializers|UUPS|ERC1967|delegatecall/g),
    },
  };
}

/* ------------------------------------------------------------------ shards */

/* Group by directory first (a directory is usually a subsystem), then split
 * any group that busts the LOC cap, then merge tiny sibling groups. Keeping
 * subsystem files together is what preserves cross-file reasoning inside a
 * shard — random file bin-packing would destroy it. */
function buildShards(root, files, locCap) {
  const measured = [];
  for (const rel of files) {
    const m = measure(path.join(root, rel));
    if (!m) continue;
    if (m.nsloc === 0) continue;
    measured.push({ file: rel, ...m });
  }

  const byDir = new Map();
  for (const f of measured) {
    const dir = path.dirname(f.file);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }

  const groups = [];
  for (const [dir, list] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Biggest files first so a huge file lands alone rather than dragging others.
    list.sort((a, b) => b.nsloc - a.nsloc);
    let cur = [];
    let curLoc = 0;
    for (const f of list) {
      if (f.nsloc >= locCap) {
        groups.push({ dir, files: [f], oversize: true });
        continue;
      }
      if (curLoc + f.nsloc > locCap && cur.length) {
        groups.push({ dir, files: cur, oversize: false });
        cur = [];
        curLoc = 0;
      }
      cur.push(f);
      curLoc += f.nsloc;
    }
    if (cur.length) groups.push({ dir, files: cur, oversize: false });
  }

  // Merge runt groups from different dirs so we do not spend a whole session on 80 lines.
  const merged = [];
  for (const g of groups) {
    const loc = g.files.reduce((s, f) => s + f.nsloc, 0);
    const last = merged[merged.length - 1];
    if (
      last &&
      !g.oversize &&
      !last.oversize &&
      loc < locCap * 0.3 &&
      last.files.reduce((s, f) => s + f.nsloc, 0) + loc <= locCap
    ) {
      last.files.push(...g.files);
      last.dir = last.dir === g.dir ? last.dir : `${last.dir} + ${g.dir}`;
      continue;
    }
    merged.push({ ...g, files: [...g.files] });
  }

  return merged.map((g, i) => {
    const nsloc = g.files.reduce((s, f) => s + f.nsloc, 0);
    const traits = {};
    for (const f of g.files) {
      for (const [k, v] of Object.entries(f.traits)) traits[k] = (traits[k] || 0) + v;
    }
    // Density per 100 nSLOC — a 200-line file with 20 requires is denser than
    // a 2000-line file with 40, and density is what should attract a lens.
    const density = {};
    for (const [k, v] of Object.entries(traits)) {
      density[k] = Number(((v / Math.max(1, nsloc)) * 100).toFixed(2));
    }
    return {
      id: `s${i + 1}`,
      subsystem: g.dir === '.' ? '(root)' : g.dir,
      nsloc,
      oversize: !!g.oversize,
      file_count: g.files.length,
      files: g.files.map((f) => f.file),
      per_file_nsloc: Object.fromEntries(g.files.map((f) => [f.file, f.nsloc])),
      traits,
      density,
    };
  });
}

/* ------------------------------------------------------------------ lenses */

/* The 12 auditor lenses, unchanged in content — these ids point at the
 * ORIGINAL agent files in solidity-auditor/references/hacking-agents/.
 * `w` is the trait-affinity weighting used only for ORDERING. */
const AUDIT_LENSES = [
  { id: 'math-precision', file: 'math-precision-agent.md', kind: 'specialty', w: { arith: 3, value: 1, aggregate: 1 } },
  { id: 'access-control', file: 'access-control-agent.md', kind: 'specialty', w: { access: 3, entrypoints: 1, upgradeable: 1 } },
  { id: 'economic-security', file: 'economic-security-agent.md', kind: 'specialty', w: { value: 3, arith: 1, paired: 1 } },
  { id: 'execution-trace', file: 'execution-trace-agent.md', kind: 'specialty', w: { external: 3, state: 1, assembly: 1 } },
  { id: 'invariant', file: 'invariant-agent.md', kind: 'specialty', w: { aggregate: 3, paired: 2, value: 1 } },
  { id: 'periphery', file: 'periphery-agent.md', kind: 'specialty', w: { external: 2, entrypoints: 2, upgradeable: 1 } },
  { id: 'first-principles', file: 'first-principles-agent.md', kind: 'specialty', w: { state: 2, entrypoints: 1, value: 1 } },
  { id: 'asymmetry', file: 'asymmetry-agent.md', kind: 'specialty', w: { paired: 3, arith: 1, aggregate: 1 } },
  { id: 'boundary', file: 'boundary-agent.md', kind: 'specialty', w: { bounds: 3, arith: 1, state: 1 } },
  { id: 'numerical-gap', file: 'numerical-gap-agent.md', kind: 'gap-hunter', w: { arith: 2, bounds: 2, value: 1 } },
  { id: 'trust-gap', file: 'trust-gap-agent.md', kind: 'gap-hunter', w: { access: 2, external: 2, upgradeable: 1 } },
  { id: 'flow-gap', file: 'flow-gap-agent.md', kind: 'gap-hunter', w: { external: 2, paired: 2, state: 1 } },
];

/* The 5 fizz invariant-discovery lenses, likewise pointing at originals. */
const FIZZ_LENSES = [
  { id: 'conservation-auditor', file: 'invariant-discovery/conservation-auditor.md', w: { aggregate: 3, value: 1 } },
  { id: 'roundtrip-rounding-analyst', file: 'invariant-discovery/roundtrip-rounding-analyst.md', w: { arith: 3, paired: 1 } },
  { id: 'state-transition-mapper', file: 'invariant-discovery/state-transition-mapper.md', w: { state: 3, entrypoints: 1 } },
  { id: 'adversarial-profit-maximizer', file: 'invariant-discovery/adversarial-profit-maximizer.md', w: { value: 3, external: 1 } },
  { id: 'protocol-type-specialist', file: 'invariant-discovery/protocol-type-specialist.md', w: { value: 2, paired: 2 } },
];

function affinity(lens, shard) {
  let score = 0;
  let weightSum = 0;
  for (const [trait, w] of Object.entries(lens.w)) {
    score += (shard.density[trait] || 0) * w;
    weightSum += w;
  }
  return score / Math.max(1, weightSum);
}

/* Risk of a shard, independent of lens: value at stake x reachable surface. */
function shardRisk(shard) {
  const d = shard.density;
  return (
    (d.value || 0) * 1.2 +
    (d.entrypoints || 0) * 2.0 +
    (d.external || 0) * 1.0 +
    (d.aggregate || 0) * 1.0 +
    (d.assembly || 0) * 2.0 +
    (d.upgradeable || 0) * 1.0
  );
}

function normalise(values) {
  const max = Math.max(...values, 0.0001);
  return values.map((v) => v / max);
}

/* --------------------------------------------------------------- unit plan */

function planAuditUnits(shards, maxUnits) {
  const lenses = AUDIT_LENSES;
  const risks = normalise(shards.map(shardRisk));
  const pairs = [];

  shards.forEach((sh, si) => {
    lenses.forEach((ln) => {
      const aff = affinity(ln, sh);
      pairs.push({ shard: sh, lens: ln, aff, risk: risks[si] });
    });
  });

  const affs = normalise(pairs.map((p) => p.aff));
  pairs.forEach((p, i) => {
    p.affN = affs[i];
    // Priority: 0-100. Risk of the ground and fitness of the lens both matter,
    // and a small floor keeps every (lens, shard) pair reachable so a long
    // enough run degenerates to exactly the original exhaustive behaviour.
    p.pri = Math.round(8 + 56 * p.affN + 36 * p.risk);
  });

  // Guarantee coverage before depth: every shard gets its best lens, and every
  // lens gets its best shard, before any second pass is scheduled. Without
  // this a trait-heavy shard would hog the whole budget.
  const chosen = [];
  const taken = new Set();
  const key = (p) => `${p.lens.id}:${p.shard.id}`;

  const bestPerShard = new Map();
  const bestPerLens = new Map();
  for (const p of pairs) {
    const bs = bestPerShard.get(p.shard.id);
    if (!bs || p.pri > bs.pri) bestPerShard.set(p.shard.id, p);
    const bl = bestPerLens.get(p.lens.id);
    if (!bl || p.pri > bl.pri) bestPerLens.set(p.lens.id, p);
  }
  for (const p of [...bestPerShard.values(), ...bestPerLens.values()]) {
    if (taken.has(key(p))) continue;
    taken.add(key(p));
    chosen.push({ ...p, pri: Math.min(100, p.pri + 12), wave: 1 });
  }
  for (const p of pairs.sort((a, b) => b.pri - a.pri)) {
    if (taken.has(key(p))) continue;
    taken.add(key(p));
    chosen.push({ ...p, wave: 2 });
  }

  const scanUnits = chosen.map((p) => ({
    id: `A-${p.lens.id}-${p.shard.id}`,
    pri: p.pri,
    kind: 'scan',
    lens: p.lens.id,
    lens_file: `references/hacking-agents/${p.lens.file}`,
    lens_kind: p.lens.kind,
    shard: p.shard.id,
    subsystem: p.shard.subsystem,
    nsloc: p.shard.nsloc,
    files: p.shard.files,
    deps: ['A-map'],
    wave: p.wave,
    notes: `affinity ${p.affN.toFixed(2)} · risk ${p.risk.toFixed(2)}`,
  }));

  const capped = maxUnits ? scanUnits.slice(0, Number(maxUnits)) : scanUnits;

  // MAP first: a cheap structural digest of the WHOLE codebase that every
  // later session loads. This is what lets a lens reason about code it never
  // opens, and is the single most important unit in the queue.
  const map = {
    id: 'A-map',
    pri: 100,
    kind: 'map',
    step: 'build MAP.md digest of all shards',
    files: [],
    deps: [],
    notes: 'structural digest; every later unit depends on it',
  };

  // SEAM units: the three gap-hunters, plus the cross-shard pass, run over the
  // digest + accumulated findings rather than raw source. This is how
  // cross-file reasoning survives sharding.
  const seams =
    shards.length > 1
      ? AUDIT_LENSES.filter((l) => l.kind === 'gap-hunter').map((l, i) => ({
          id: `A-seam-${l.id}`,
          pri: 30 - i,
          kind: 'seam',
          lens: l.id,
          lens_file: `references/hacking-agents/${l.file}`,
          lens_kind: 'gap-hunter',
          shard: 'SEAMS',
          files: [],
          deps: capped.filter((u) => u.wave === 1).map((u) => u.id),
          notes: 'cross-shard seams: read MAP.md + all findings, targeted source only',
        }))
      : [];

  const reduce = {
    id: 'A-reduce',
    pri: 1,
    kind: 'reduce',
    step: 'dedup + gate + report',
    files: [],
    deps: [...capped.map((u) => u.id), ...seams.map((u) => u.id)],
    notes: 'runs every MANDATORY dedup gate and judging.md verbatim',
  };

  return [map, ...capped, ...seams, reduce];
}

function planXrayUnits(shards) {
  const units = [
    { id: 'X-enumerate', pri: 100, kind: 'map', step: 'Step 1 — enumerate, git security, coverage, MAP.md', files: [], deps: [] },
  ];
  const risks = normalise(shards.map(shardRisk));
  shards.forEach((sh, i) => {
    units.push({
      id: `X-facts-${sh.id}`,
      pri: Math.round(60 + 35 * risks[i]),
      kind: 'extract',
      step: 'Step 2 — deltas, guards, transitions, access map, entry points',
      shard: sh.id,
      subsystem: sh.subsystem,
      nsloc: sh.nsloc,
      files: sh.files,
      deps: ['X-enumerate'],
    });
  });
  const factIds = shards.map((sh) => `X-facts-${sh.id}`);
  units.push(
    { id: 'X-entrypoints', pri: 50, kind: 'synthesize', step: 'Step 2b/2b-flow — classify entry points, build flow paths', files: [], deps: factIds },
    { id: 'X-classify', pri: 48, kind: 'synthesize', step: 'Steps 2c/2d/2e — backwards-compat, centralization, pause, protocol type', files: [], deps: factIds },
    { id: 'X-invariants', pri: 46, kind: 'synthesize', step: 'Step 2g — full invariant taxonomy walk + verification gate', files: [], deps: factIds },
    { id: 'X-write-invariants', pri: 30, kind: 'write', step: 'Step 3a — invariants.md', files: [], deps: ['X-invariants'] },
    { id: 'X-write-entrypoints', pri: 28, kind: 'write', step: 'Step 3a — entry-points.md', files: [], deps: ['X-entrypoints'] },
    { id: 'X-write-xray', pri: 26, kind: 'write', step: 'Step 3a — x-ray.md + architecture.json', files: [], deps: ['X-write-invariants', 'X-write-entrypoints', 'X-classify'] },
    { id: 'X-svg', pri: 10, kind: 'write', step: 'Step 3b/3c — architecture.svg, audit loop, verdict', files: [], deps: ['X-write-xray'] }
  );
  return units;
}

function planFizzUnits(shards) {
  const contractShards = shards.map((s) => s.id);
  const units = [
    { id: 'F-tooling', pri: 100, kind: 'setup', step: 'Steps 0-2 — verify tooling, forge build, extract ABIs', files: [], deps: [] },
    { id: 'F-understand', pri: 95, kind: 'map', step: 'Step 3 — x-ray acquisition / protocol understanding + MAP.md', files: [], deps: ['F-tooling'] },
    { id: 'F-select', pri: 90, kind: 'setup', step: 'Steps 4-4.5 — entry-point selection, tiering, cost estimate', files: [], deps: ['F-understand'] },
    { id: 'F-scaffold', pri: 85, kind: 'write', step: 'Step 5 — generate scaffold', files: [], deps: ['F-select'] },
    { id: 'F-setup', pri: 80, kind: 'write', step: 'Step 6 — wire Base.sol setup() until it compiles', files: [], deps: ['F-scaffold'] },
  ];
  shards.forEach((sh, i) => {
    units.push({
      id: `F-handlers-${sh.id}`,
      pri: 70 - i,
      kind: 'write',
      step: 'Step 7 — refine handlers for this shard',
      shard: sh.id,
      subsystem: sh.subsystem,
      files: sh.files,
      deps: ['F-setup'],
    });
  });
  const handlerIds = shards.map((sh) => `F-handlers-${sh.id}`);
  units.push({ id: 'F-coverage-1', pri: 60, kind: 'loop', step: 'Step 8 — coverage cycle 1 (profile detect + Medusa)', files: [], deps: handlerIds });
  FIZZ_LENSES.forEach((l, i) => {
    units.push({
      id: `F-discover-${l.id}`,
      pri: 55 - i,
      kind: 'scan',
      lens: l.id,
      lens_file: `agents/${l.file}`,
      step: 'Step 9b — invariant discovery',
      files: [],
      deps: ['F-coverage-1'],
    });
  });
  const discoverIds = FIZZ_LENSES.map((l) => `F-discover-${l.id}`);
  units.push(
    { id: 'F-synthesize', pri: 45, kind: 'reduce', step: 'Step 9c — synthesizer → property-plan.md + PROPERTIES.md', files: [], deps: discoverIds },
    { id: 'F-impl-global', pri: 40, kind: 'write', step: 'Step 9d — global property implementer', files: [], deps: ['F-synthesize'] },
    { id: 'F-impl-specific', pri: 39, kind: 'write', step: 'Step 9d — specific property implementer', files: [], deps: ['F-synthesize'] },
    { id: 'F-validate', pri: 35, kind: 'setup', step: 'Step 9e — build + fix compile errors', files: [], deps: ['F-impl-global', 'F-impl-specific'] },
    { id: 'F-campaign', pri: 30, kind: 'loop', step: 'Step 10 — run campaign, triage by Guarantee tag', files: [], deps: ['F-validate'] },
    { id: 'F-repro', pri: 20, kind: 'write', step: 'Step 11 — violation repros in FoundryTester', files: [], deps: ['F-campaign'] },
    { id: 'F-report', pri: 10, kind: 'reduce', step: 'Step 11 — report.md + fizz_sync snapshot', files: [], deps: ['F-repro'] }
  );
  return units.map((u) => ({ ...u, notes: u.notes || `${contractShards.length} shard(s)` }));
}

/* ---------------------------------------------------------------- commands */

function cmdScan(args) {
  const root = path.resolve(String(args.root || process.cwd()));
  const locCap = Number(args.loc || 2500);
  const srcDirs = args.src && args.src !== true ? String(args.src).split(',') : null;

  let files = [];
  if (srcDirs) {
    for (const s of srcDirs) {
      const dir = path.join(root, s.trim());
      if (fs.existsSync(dir)) files.push(...walk(dir, [], root.length));
    }
  } else {
    for (const guess of ['src', 'contracts']) {
      const dir = path.join(root, guess);
      if (fs.existsSync(dir)) files.push(...walk(dir, [], root.length));
    }
    if (files.length === 0) files = walk(root, [], root.length);
  }
  files = [...new Set(files)].sort();
  if (files.length === 0) die(`no in-scope .sol files found under ${root}`);

  const shards = buildShards(root, files, locCap);
  const totalLoc = shards.reduce((s, x) => s + x.nsloc, 0);
  const manifest = {
    schema: 'relay-shards-v1',
    root,
    generated: new Date().toISOString(),
    loc_cap: locCap,
    file_count: files.length,
    total_nsloc: totalLoc,
    shard_count: shards.length,
    shards,
  };

  const outPath = path.resolve(root, String(args.out || '.relay/shards.json'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  process.stdout.write(`root        ${root}\n`);
  process.stdout.write(`in scope    ${files.length} file(s), ${totalLoc} nSLOC\n`);
  process.stdout.write(`loc cap     ${locCap} per shard\n`);
  process.stdout.write(`shards      ${shards.length}\n\n`);
  process.stdout.write('| shard | subsystem | files | nSLOC | risk | top traits |\n');
  process.stdout.write('|---|---|---|---|---|---|\n');
  for (const s of shards) {
    const top = Object.entries(s.density)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    process.stdout.write(
      `| ${s.id} | ${s.subsystem}${s.oversize ? ' ⚠oversize' : ''} | ${s.file_count} | ${s.nsloc} | ` +
        `${shardRisk(s).toFixed(1)} | ${top} |\n`
    );
  }
  const over = shards.filter((s) => s.oversize);
  if (over.length) {
    process.stdout.write(
      `\n⚠️  ${over.length} shard(s) hold a single file larger than the cap ` +
        `(${over.map((s) => `${s.id}:${s.nsloc}`).join(', ')}). Split these by ` +
        `contract or by function group when you claim them — see references/sharding.md.\n`
    );
  }
  process.stdout.write(`\nwrote ${outPath}\n`);
}

function cmdUnits(args) {
  const manifestPath = path.resolve(String(args.shards || '.relay/shards.json'));
  if (!fs.existsSync(manifestPath)) die(`no shard manifest at ${manifestPath} — run "shard.js scan" first`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const track = String(args.track || '');

  let units;
  if (track === 'solidity-auditor') units = planAuditUnits(manifest.shards, args['max-units']);
  else if (track === 'x-ray') units = planXrayUnits(manifest.shards);
  else if (track === 'fizz') units = planFizzUnits(manifest.shards);
  else die('--track must be one of: solidity-auditor, x-ray, fizz');

  const outPath = path.resolve(manifest.root, String(args.out || '.relay/units.json'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({ schema: 'relay-units-v1', track, units }, null, 2)}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(units, null, 2)}\n`);
    return;
  }
  process.stdout.write(`track  ${track}\n`);
  process.stdout.write(`units  ${units.length}\n\n`);
  process.stdout.write('| id | pri | kind | lens / step | shard | nSLOC | deps |\n');
  process.stdout.write('|---|---|---|---|---|---|---|\n');
  for (const u of [...units].sort((a, b) => b.pri - a.pri)) {
    process.stdout.write(
      `| ${u.id} | ${u.pri} | ${u.kind} | ${u.lens || u.step || ''} | ${u.shard || ''} | ` +
        `${u.nsloc || ''} | ${(u.deps || []).length} |\n`
    );
  }
  process.stdout.write(`\nwrote ${outPath}\n`);
  process.stdout.write(`next: node relay.js plan --root ${manifest.root} --units ${outPath}\n`);
}

const COMMANDS = { scan: cmdScan, units: cmdUnits };

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || !COMMANDS[cmd]) {
    process.stdout.write(`usage: shard.js <${Object.keys(COMMANDS).join('|')}> [options]\n`);
    process.exit(cmd ? 1 : 0);
  }
  COMMANDS[cmd](parseArgs(argv.slice(1)));
}

main();
