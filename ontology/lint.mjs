#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// ontology/lint.mjs: cross-check `ontology/seamline.yaml` against the frozen
// TypeScript contract at `packages/ontology/src/contract.ts`.
//
// The ontology is the normative specification (CC-BY-4.0) and the contract is
// the implementation seam every package compiles against (Apache-2.0). Two
// sources for one vocabulary is a drift hazard, and this file is the control:
// it fails the build on any divergence, in either direction.
//
// It reports divergence; it never repairs it. The contract is frozen and other
// packages compile against it, so a mismatch is a finding for a human, not
// something a linter should silently reconcile.
//
// Checks, all of them assertions about actual content rather than presence:
//   1. Node kinds:   classes deriving from SeamlineNode == NODE_KINDS, exactly.
//   2. Edge kinds:   classes deriving from SeamlineEdge == EDGE_KINDS, exactly.
//   3. Signatures:   every edge's declared (src, dst) pairs == EDGE_SIGNATURES, exactly.
//   4. Enums:        NodeKindEnum / EdgeKindEnum / ProvenanceEnum / SensitivityEnum
//                    / ExtractorStatusEnum / ContradictionCodeEnum match their contract lists.
//   5. Sensitivity:  each class's declared default == DEFAULT_SENSITIVITY.
//   6. Profile:      every class pins `profile`, and everything here is `core`.
//   7. Kind pinning: every class pins `kind` to its own class name.
//   8. Reachability: every node kind is the source or target of at least one
//                    edge, or carries an explicit waiver with a stated reason.
//   9. Determinism:  no created_at / updated_at slot exists (v3 §2.3, ADR-0009).
//
// Plain Node, zero dependencies: a minimal parser for the YAML subset this file
// uses, and a direct import of the contract via Node's type stripping.
//
// Usage:  node ontology/lint.mjs
// Exit:   0 clean, 1 divergence found, 2 could not run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = join(HERE, 'seamline.yaml');
const CONTRACT_PATH = join(HERE, '..', 'packages', 'ontology', 'src', 'contract.ts');

import { parseYaml } from './yaml-subset.mjs';

// ---------------------------------------------------------------------------
// Comparison helpers. Every one of these reports the actual difference, because
// "the sets differ" is not a usable failure message at 4pm on a Friday.
// ---------------------------------------------------------------------------

const problems = [];
function fail(check, message) {
  problems.push({ check, message });
}

function compareSets(check, label, fromYaml, fromContract) {
  const y = new Set(fromYaml);
  const c = new Set(fromContract);
  for (const v of y)
    if (!c.has(v)) fail(check, `${label}: '${v}' is in seamline.yaml but not in contract.ts`);
  for (const v of c)
    if (!y.has(v)) fail(check, `${label}: '${v}' is in contract.ts but not in seamline.yaml`);
}

const pair = (p) => `${p[0]} -> ${p[1]}`;

// ---------------------------------------------------------------------------

async function main() {
  let contract;
  try {
    contract = await import(CONTRACT_PATH);
  } catch (err) {
    console.error(`ontology/lint: cannot import the contract at ${CONTRACT_PATH}`);
    console.error(`  ${err.message}`);
    console.error(
      '  This lint imports contract.ts directly, using Node type stripping (Node >= 22.18 / 24).',
    );
    process.exit(2);
  }

  let doc;
  try {
    doc = parseYaml(readFileSync(YAML_PATH, 'utf8'));
  } catch (err) {
    console.error(`ontology/lint: cannot parse ${YAML_PATH}`);
    console.error(`  ${err.message}`);
    process.exit(2);
  }

  const classes = doc.classes ?? {};
  const enums = doc.enums ?? {};
  const slots = doc.slots ?? {};

  const nodeClasses = Object.entries(classes).filter(([, v]) => v && v.is_a === 'SeamlineNode');
  const edgeClasses = Object.entries(classes).filter(([, v]) => v && v.is_a === 'SeamlineEdge');

  // 1 + 2: kinds.
  compareSets(
    'node-kinds',
    'node kind',
    nodeClasses.map(([k]) => k),
    contract.NODE_KINDS,
  );
  compareSets(
    'edge-kinds',
    'edge kind',
    edgeClasses.map(([k]) => k),
    contract.EDGE_KINDS,
  );

  // 3: per-edge domain and range.
  for (const [name, def] of edgeClasses) {
    const declared = def.annotations?.seamline_signatures;
    if (!Array.isArray(declared) || declared.length === 0) {
      fail(
        'signatures',
        `${name}: no seamline_signatures declared. Every edge must enumerate its (src, dst) pairs; "all domains" is exactly the defect this check exists to prevent.`,
      );
      continue;
    }
    const bad = declared.filter((p) => !Array.isArray(p) || p.length !== 2);
    if (bad.length) {
      fail(
        'signatures',
        `${name}: ${bad.length} malformed signature entr${bad.length === 1 ? 'y' : 'ies'}; each must be a two-element [src, dst] pair.`,
      );
      continue;
    }
    const expected = contract.EDGE_SIGNATURES?.[name];
    if (!expected) continue; // already reported by the edge-kind check
    const y = new Set(declared.map(pair));
    const c = new Set(expected.map(pair));
    for (const s of y)
      if (!c.has(s))
        fail('signatures', `${name}: '${s}' is in seamline.yaml but not in EDGE_SIGNATURES`);
    for (const s of c)
      if (!y.has(s))
        fail('signatures', `${name}: '${s}' is in EDGE_SIGNATURES but not in seamline.yaml`);
  }
  for (const name of Object.keys(contract.EDGE_SIGNATURES ?? {})) {
    if (!classes[name])
      fail(
        'signatures',
        `${name}: has EDGE_SIGNATURES in contract.ts but no class in seamline.yaml`,
      );
  }

  // 4: enumerations.
  const pv = (n) => Object.keys(enums[n]?.permissible_values ?? {});
  compareSets('enums', 'NodeKindEnum', pv('NodeKindEnum'), contract.NODE_KINDS);
  compareSets('enums', 'EdgeKindEnum', pv('EdgeKindEnum'), contract.EDGE_KINDS);
  compareSets('enums', 'ProvenanceEnum', pv('ProvenanceEnum'), contract.PROVENANCE);
  compareSets('enums', 'SensitivityEnum', pv('SensitivityEnum'), contract.SENSITIVITY);
  compareSets('enums', 'ExtractorStatusEnum', pv('ExtractorStatusEnum'), contract.EXTRACTOR_STATUS);
  compareSets(
    'enums',
    'ContradictionCodeEnum',
    pv('ContradictionCodeEnum'),
    contract.CONTRADICTION_CODES,
  );
  compareSets('enums', 'ProfileEnum', pv('ProfileEnum'), ['core', 'extended', 'vendor']);

  // 5: default sensitivity per kind.
  for (const [name, def] of nodeClasses) {
    const declared = def.annotations?.seamline_default_sensitivity;
    const expected = contract.DEFAULT_SENSITIVITY?.[name];
    if (declared == null)
      fail(
        'sensitivity',
        `${name}: no seamline_default_sensitivity declared. Export is default-deny; a kind with no classification has no default to deny from.`,
      );
    else if (expected != null && declared !== expected)
      fail(
        'sensitivity',
        `${name}: seamline.yaml says '${declared}', DEFAULT_SENSITIVITY says '${expected}'`,
      );
  }

  // 6 + 7: profile and kind pinning, on node and edge classes alike.
  for (const [name, def] of [...nodeClasses, ...edgeClasses]) {
    const p = def.slot_usage?.profile?.equals_string;
    if (p == null)
      fail('profile', `${name}: does not pin a profile. Every class carries one (ADR-0001).`);
    else if (p !== 'core')
      fail(
        'profile',
        `${name}: profile is '${p}'. Everything authored so far is core; a non-core kind needs a design-spec pass and a named consumer.`,
      );
    const k = def.slot_usage?.kind?.equals_string;
    if (k == null) fail('kind-pinning', `${name}: does not pin its kind.`);
    else if (k !== name)
      fail('kind-pinning', `${name}: pins kind '${k}', which does not match the class name.`);
  }

  // 8: reachability, or an explicit waiver with a stated reason.
  const touched = new Set();
  for (const [, def] of edgeClasses) {
    for (const p of def.annotations?.seamline_signatures ?? []) {
      if (Array.isArray(p) && p.length === 2) {
        touched.add(p[0]);
        touched.add(p[1]);
      }
    }
  }
  const waived = [];
  for (const [name, def] of nodeClasses) {
    if (touched.has(name)) continue;
    const waiver = def.annotations?.seamline_unreachable_waiver;
    if (typeof waiver === 'string' && waiver.trim().length >= 40) waived.push(name);
    else if (typeof waiver === 'string')
      fail(
        'reachability',
        `${name}: is the source or target of no edge, and its waiver is too short to be a reason. State why the kind exists with no edge.`,
      );
    else
      fail(
        'reachability',
        `${name}: is the source or target of no edge, and has no seamline_unreachable_waiver. Either connect it or state why it is unconnected.`,
      );
  }

  // 9: determinism. No wall-clock timestamp may appear in a node or edge body.
  for (const banned of ['created_at', 'updated_at', 'createdAt', 'updatedAt', 'timestamp']) {
    if (slots[banned])
      fail(
        'determinism',
        `slot '${banned}' exists. Byte-identical output is a release gate; time belongs to the Run record, not to a fact (ADR-0009).`,
      );
  }
  for (const [name, def] of [...nodeClasses, ...edgeClasses]) {
    for (const s of def.slots ?? []) {
      if (/created_at|updated_at|timestamp/i.test(String(s)))
        fail('determinism', `${name}: declares slot '${s}'.`);
    }
  }

  // ---- report -------------------------------------------------------------

  const nodeCount = nodeClasses.length;
  const edgeCount = edgeClasses.length;
  const sigCount = edgeClasses.reduce(
    (a, [, d]) => a + (d.annotations?.seamline_signatures?.length ?? 0),
    0,
  );

  console.log('ontology/lint: seamline.yaml vs packages/ontology/src/contract.ts');
  console.log(
    `  ontology:  ${nodeCount} node kinds, ${edgeCount} edge kinds, ${sigCount} domain/range pairs`,
  );
  console.log(
    `  contract:  ${contract.NODE_KINDS.length} node kinds, ${contract.EDGE_KINDS.length} edge kinds, ${Object.values(contract.EDGE_SIGNATURES).reduce((a, b) => a + b.length, 0)} domain/range pairs`,
  );
  console.log(
    `  reachability: ${nodeCount - waived.length} connected, ${waived.length} waived${waived.length ? ` (${waived.join(', ')})` : ''}`,
  );

  if (problems.length === 0) {
    console.log('  OK, no divergence.');
    process.exit(0);
  }

  const byCheck = new Map();
  for (const p of problems) {
    if (!byCheck.has(p.check)) byCheck.set(p.check, []);
    byCheck.get(p.check).push(p.message);
  }
  console.error(`\n  ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const [check, msgs] of byCheck) {
    console.error(`\n  [${check}]`);
    for (const m of msgs) console.error(`    - ${m}`);
  }
  console.error(
    '\n  contract.ts is frozen and other packages compile against it. Fix seamline.yaml,',
  );
  console.error('  or raise the divergence for a coordinated contract change. Do not edit the');
  console.error('  contract to silence this lint.\n');
  process.exit(1);
}

main().catch((err) => {
  console.error(`ontology/lint: ${err.stack ?? err.message}`);
  process.exit(2);
});
