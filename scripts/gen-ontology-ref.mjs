#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// scripts/gen-ontology-ref.mjs: render docs/reference/ontology.md from
// ontology/seamline.yaml and the extractor manifests.
//
// The ontology is the normative vocabulary (CC-BY-4.0). This script turns it
// into a readable reference: every node kind, every edge kind with its
// domain/range pairs, the fields every node and edge carries, the
// enumerations, and which extractor claims authority for each kind.
//
// Deterministic: everything is sorted by plain code-unit order, there is no
// timestamp, and the same inputs always give the same bytes. That is what lets
// `--check` mean something.
//
// Sources, and what each contributes:
//   ontology/seamline.yaml   kinds, groups, profiles, sensitivities, natural
//                            keys, edge signatures, fields, enumerations.
//                            Parsed with ontology/yaml-subset.mjs, the same
//                            reader ontology/lint.mjs uses (no dependency).
//   extractor manifests      `produces` of each extractor: the node kinds it is
//                            authoritative for, and (infer-join only) the edge
//                            kinds named by its selector. Edge production is
//                            only listed where a manifest declares it; the
//                            other extractors do not declare their edges.
//
// Not generated, because neither source declares it: per-kind `props` keys.
// `props` is an open map in the ontology. The property names the contradiction
// detectors read are documented in docs/contradictions/.
//
// Usage:
//   node --experimental-strip-types scripts/gen-ontology-ref.mjs            write the file
//   node --experimental-strip-types scripts/gen-ontology-ref.mjs --check    exit 1 when stale
//   ... --out <path>                                                        use another path
//
// The manifests are TypeScript, imported with Node's type stripping, and they
// import `@seamline/ontology` through its built output, so run `pnpm build`
// first on a fresh checkout. `pnpm verify` builds before it gets here.
//
// Exit: 0 fresh (or written), 1 stale or missing under --check, 2 could not run.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseYaml } from '../ontology/yaml-subset.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YAML_PATH = join(ROOT, 'ontology', 'seamline.yaml');
const DEFAULT_OUT = join(ROOT, 'docs', 'reference', 'ontology.md');
const CONTRADICTION_PAGES = join(ROOT, 'docs', 'contradictions');

/** Every extractor-like package, with the module and export that hold its manifest. */
const MANIFEST_SOURCES = [
  {
    pkg: 'extract-change',
    path: 'packages/extract-change/src/manifest.ts',
    exportName: 'CHANGE_MANIFEST',
  },
  {
    pkg: 'extract-code-ts',
    path: 'packages/extract-code-ts/src/manifest.ts',
    exportName: 'manifest',
  },
  {
    pkg: 'extract-contracts',
    path: 'packages/extract-contracts/src/manifest.ts',
    exportName: 'MANIFEST',
  },
  { pkg: 'extract-data', path: 'packages/extract-data/src/extractor.ts', exportName: 'MANIFEST' },
  {
    pkg: 'infer-join',
    path: 'packages/infer-join/src/manifest.ts',
    exportName: 'INFER_JOIN_MANIFEST',
  },
];

class CouldNotRun extends Error {}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One markdown table cell: no pipes, no line breaks. */
function cell(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

const code = (s) => `\`${s}\``;

async function loadManifests() {
  const packagesDir = join(ROOT, 'packages');
  const listed = new Set(MANIFEST_SOURCES.map((s) => s.pkg));
  for (const name of readdirSync(packagesDir).sort(cmp)) {
    if ((name.startsWith('extract-') || name.startsWith('infer-')) && !listed.has(name)) {
      throw new CouldNotRun(
        `packages/${name} looks like an extractor but is not listed in MANIFEST_SOURCES in scripts/gen-ontology-ref.mjs`,
      );
    }
  }
  const manifests = [];
  for (const source of MANIFEST_SOURCES) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(ROOT, source.path)).href);
    } catch (err) {
      throw new CouldNotRun(
        `cannot load ${source.path}: ${err.message}\n  (the manifests import @seamline/ontology from its built output; run \`pnpm build\` first)`,
      );
    }
    const manifest = mod[source.exportName];
    if (
      manifest === undefined ||
      typeof manifest.name !== 'string' ||
      !Array.isArray(manifest.produces)
    ) {
      throw new CouldNotRun(`${source.path} does not export a manifest named ${source.exportName}`);
    }
    manifests.push(manifest);
  }
  return manifests.sort((a, b) => cmp(a.name, b.name));
}

/** Kind to sorted extractor names, from the manifests' `produces` claims. */
function producersOf(manifests, nodeKinds, edgeKinds) {
  const node = new Map();
  const edge = new Map();
  const add = (map, kind, extractor) => {
    if (!map.has(kind)) map.set(kind, new Set());
    map.get(kind).add(extractor);
  };
  for (const m of manifests) {
    for (const claim of m.produces) {
      for (const kind of claim.kinds ?? []) {
        if (!nodeKinds.has(kind)) {
          throw new CouldNotRun(
            `${m.name} claims node kind ${kind}, which seamline.yaml does not define`,
          );
        }
        add(node, kind, m.name);
      }
      // An edge-only extractor names its edge kinds in the selector, `A|B|C`.
      if (
        typeof claim.selector === 'string' &&
        /^[A-Z][A-Z_]*(\|[A-Z][A-Z_]*)*$/.test(claim.selector)
      ) {
        for (const token of claim.selector.split('|')) {
          if (!edgeKinds.has(token)) {
            throw new CouldNotRun(
              `${m.name} selector names edge kind ${token}, which seamline.yaml does not define`,
            );
          }
          add(edge, token, m.name);
        }
      }
    }
  }
  const sorted = (map, kind) => [...(map.get(kind) ?? [])].sort(cmp);
  return { node: (k) => sorted(node, k), edge: (k) => sorted(edge, k) };
}

function producedBy(list) {
  return list.length === 0 ? 'none declared' : list.map(code).join(', ');
}

function groupBy(entries, groupOf) {
  const groups = new Map();
  for (const entry of entries) {
    const g = groupOf(entry) ?? 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(entry);
  }
  return [...groups.keys()]
    .sort(cmp)
    .map((g) => [g, groups.get(g).sort((a, b) => cmp(a[0], b[0]))]);
}

function contradictionLink(value) {
  const m = /^X(\d+)_/.exec(value);
  if (m === null) return code(value);
  const page = join(CONTRADICTION_PAGES, `X${m[1]}.md`);
  return existsSync(page) ? `[${code(value)}](../contradictions/X${m[1]}.md)` : code(value);
}

function renderFields(title, slotNames, slotDefs) {
  const lines = [
    `### ${title}`,
    '',
    '| Field | Required | Range | Description |',
    '|---|---|---|---|',
  ];
  for (const name of slotNames) {
    const def = slotDefs[name] ?? {};
    lines.push(
      `| ${code(name)} | ${def.required === true ? 'yes' : 'no'} | ${code(def.range ?? 'string')} | ${cell(def.description)} |`,
    );
  }
  lines.push('');
  return lines;
}

async function build() {
  let doc;
  try {
    doc = parseYaml(readFileSync(YAML_PATH, 'utf8'));
  } catch (err) {
    throw new CouldNotRun(`cannot parse ${relative(ROOT, YAML_PATH)}: ${err.message}`);
  }
  const classes = doc.classes ?? {};
  const enums = doc.enums ?? {};
  const slotDefs = doc.slots ?? {};

  const nodeEntries = Object.entries(classes).filter(([, v]) => v && v.is_a === 'SeamlineNode');
  const edgeEntries = Object.entries(classes).filter(([, v]) => v && v.is_a === 'SeamlineEdge');
  const nodeKinds = new Set(nodeEntries.map(([k]) => k));
  const edgeKinds = new Set(edgeEntries.map(([k]) => k));

  const manifests = await loadManifests();
  const producers = producersOf(manifests, nodeKinds, edgeKinds);

  const pairCount = edgeEntries.reduce(
    (n, [, d]) => n + (d.annotations?.seamline_signatures?.length ?? 0),
    0,
  );
  const out = [];

  out.push(
    '<!-- Generated by scripts/gen-ontology-ref.mjs from ontology/seamline.yaml and the extractor manifests. -->',
    '<!-- Do not edit by hand. Regenerate with `pnpm gen:ontology-ref`; `pnpm gate:ontology-ref` fails when this file is stale. -->',
    '',
    '# Ontology reference',
    '',
    `Generated from [${code('ontology/seamline.yaml')}](../../ontology/seamline.yaml), version ${doc.version}, ${doc.status}. The vocabulary is licensed ${doc.license}. The normative source is the YAML; this page is a rendering of it and is checked against it on every ${code('pnpm verify')}.`,
    '',
    '| | |',
    '|---|---|',
    `| Node kinds | ${nodeEntries.length} |`,
    `| Edge kinds | ${edgeEntries.length} |`,
    `| Domain/range pairs | ${pairCount} |`,
    `| Extractors with a manifest | ${manifests.length} |`,
    '',
    'Kind names are identity tokens: the same spelling is used in the YAML, in `packages/ontology/src/contract.ts`, in serialized output and in queries. The agreement between the YAML and the contract is enforced by `ontology/lint.mjs` (`pnpm gate:ontology`).',
    '',
  );

  // ---- node kinds ----------------------------------------------------------
  out.push('## Node kinds', '');
  out.push(
    '"Produced by" lists the extractors whose manifest claims authority for the kind in `produces`. A kind with no producer is one no extractor manifest claims; the host may still write it (it writes `Alias` nodes on every extraction, and it keeps runs and extractor results in their own store tables, `runs` and `extractor_results`, rather than as `Run` or `Extractor` nodes). An extractor may also emit a kind as an edge endpoint without claiming it (`extract-change` emits `File` that way), which is not listed.',
    '',
  );
  for (const [group, entries] of groupBy(nodeEntries, ([, d]) => d.annotations?.seamline_group)) {
    out.push(
      `### ${group}`,
      '',
      '| Kind | Profile | Default sensitivity | Natural key | Produced by | Description |',
      '|---|---|---|---|---|---|',
    );
    for (const [kind, def] of entries) {
      // The key is a parenthesized tuple; a few kinds append a sentence of rationale after it.
      const naturalKey = String(def.annotations?.seamline_natural_key ?? '');
      const split = /^(\([^)]*\))\s*([\s\S]*)$/.exec(naturalKey);
      const key = split === null ? naturalKey : split[1];
      const keyNote = split === null || split[2] === '' ? '' : ` Identity: ${split[2]}`;
      out.push(
        `| ${code(kind)} | ${cell(def.slot_usage?.profile?.equals_string)} | ${cell(def.annotations?.seamline_default_sensitivity)} | ${code(cell(key))} | ${cell(producedBy(producers.node(kind)))} | ${cell(`${def.description ?? ''}${keyNote}`)} |`,
      );
    }
    out.push('');
  }

  const waived = nodeEntries
    .filter(([, d]) => typeof d.annotations?.seamline_unreachable_waiver === 'string')
    .sort((a, b) => cmp(a[0], b[0]));
  if (waived.length > 0) {
    out.push(
      '### Kinds with no edges',
      '',
      'These kinds are the source or target of no edge in the core profile. Each carries a recorded reason in the YAML (`seamline_unreachable_waiver`).',
      '',
    );
    for (const [kind, def] of waived)
      out.push(`- ${code(kind)}: ${cell(def.annotations.seamline_unreachable_waiver)}`);
    out.push('');
  }

  // ---- edge kinds ----------------------------------------------------------
  out.push('## Edge kinds', '');
  out.push(
    'Every edge declares its domain and range as an enumerated list of (source, target) pairs; "any to any" is not allowed. Edge identity is `UNIQUE(scope, src, dst, kind)`. Only `infer-join` declares its edge kinds in its manifest (as the selector of its `produces` claim), so for every other edge the "Produced by" column reads "none declared": the other extractors do not state their edges in a machine-readable form.',
    '',
  );
  for (const [group, entries] of groupBy(edgeEntries, ([, d]) => d.annotations?.seamline_group)) {
    out.push(
      `### ${group}`,
      '',
      '| Edge | Profile | Domain to range | Produced by | Description |',
      '|---|---|---|---|---|',
    );
    for (const [kind, def] of entries) {
      const pairs = (def.annotations?.seamline_signatures ?? [])
        .map((p) => `${code(p[0])} to ${code(p[1])}`)
        .sort(cmp)
        .join('; ');
      out.push(
        `| ${code(kind)} | ${cell(def.slot_usage?.profile?.equals_string)} | ${cell(pairs)} | ${cell(producedBy(producers.edge(kind)))} | ${cell(def.description)} |`,
      );
    }
    out.push('');
  }

  // ---- fields --------------------------------------------------------------
  out.push('## Fields carried by every node and edge', '');
  out.push(
    'Field names are written as in the YAML (snake_case); the TypeScript contract uses camelCase (`first_seen_run` is `firstSeenRun`) and the mapping is mechanical. `created_at` and `updated_at` are deliberately absent: byte-identical output is a release gate, and time belongs to the run, not to the fact.',
    '',
  );
  out.push(...renderFields('Node fields', classes.SeamlineNode?.slots ?? [], slotDefs));
  out.push(...renderFields('Edge fields', classes.SeamlineEdge?.slots ?? [], slotDefs));
  out.push(
    '### Kind-specific properties',
    '',
    'Kind-specific values live in the open `props` map (string, number, boolean or null values, sorted by key before serialization). The ontology does not declare per-kind property keys, so none are listed here. The property names the contradiction detectors read, and the extractors that emit them, are documented per code in [docs/contradictions](../contradictions/README.md).',
    '',
  );

  // ---- enumerations --------------------------------------------------------
  out.push('## Enumerations', '');
  for (const name of Object.keys(enums).sort(cmp)) {
    const def = enums[name];
    out.push(`### ${name}`, '', cell(def.description), '');
    for (const value of Object.keys(def.permissible_values ?? {}).sort(cmp)) {
      const description = def.permissible_values[value]?.description;
      const label = name === 'ContradictionCodeEnum' ? contradictionLink(value) : code(value);
      out.push(description ? `- ${label}: ${cell(description)}` : `- ${label}`);
    }
    out.push('');
  }

  // ---- extractor manifests -------------------------------------------------
  out.push('## Extractor manifests', '');
  out.push(
    'What each extractor declares in its capability manifest. `provenanceCeiling` is the highest provenance the host lets it emit; a claim names a scope, the node kinds the extractor is authoritative for in that scope, and a selector bounding the claim.',
    '',
    '| Extractor | Provenance ceiling | Scope | Node kinds | Selector |',
    '|---|---|---|---|---|',
  );
  for (const m of manifests) {
    for (const claim of [...m.produces].sort((a, b) => cmp(a.scope, b.scope))) {
      const kinds = [...(claim.kinds ?? [])].sort(cmp);
      out.push(
        `| ${code(m.name)} | ${cell(m.provenanceCeiling)} | ${code(claim.scope)} | ${cell(kinds.length === 0 ? 'none' : kinds.map(code).join(', '))} | ${cell(claim.selector === undefined ? 'none' : code(claim.selector))} |`,
      );
    }
  }
  out.push('');

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}

function firstDifference(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) {
      return `line ${i + 1}:\n    committed: ${x[i] ?? '(end of file)'}\n    generated: ${y[i] ?? '(end of file)'}`;
    }
  }
  return 'no line differs';
}

async function main(argv) {
  const check = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  if (outIndex !== -1 && argv[outIndex + 1] === undefined)
    throw new CouldNotRun('--out needs a path');
  const outPath = outIndex === -1 ? DEFAULT_OUT : resolve(argv[outIndex + 1]);
  const shown = relative(ROOT, outPath).split(sep).join('/');

  const rendered = await build();

  if (!check) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered);
    console.log(`gen-ontology-ref: wrote ${shown}`);
    return 0;
  }

  let committed = null;
  try {
    committed = readFileSync(outPath, 'utf8');
  } catch {
    committed = null;
  }
  if (committed === rendered) {
    console.log(`gen-ontology-ref: ${shown} is up to date`);
    return 0;
  }
  console.error(`gen-ontology-ref: ${shown} is ${committed === null ? 'missing' : 'stale'}.`);
  if (committed !== null)
    console.error(`  first difference at ${firstDifference(committed, rendered)}`);
  console.error('  Run `pnpm gen:ontology-ref` and commit the result.');
  return 1;
}

main(process.argv.slice(2)).then(
  (code_) => {
    process.exitCode = code_;
  },
  (err) => {
    console.error(
      `gen-ontology-ref: ${err instanceof CouldNotRun ? err.message : (err.stack ?? err.message)}`,
    );
    process.exitCode = 2;
  },
);
