# @seamline/ontology
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The typed contract every Seamline package builds against: node kinds, edge kinds, domain/range restrictions, sensitivity defaults, provenance precedence, and identity rules. This code is the compiled mirror of `ontology/seamline.yaml`, kept in sync by `ontology/lint.mjs` as a release gate.

Most users should not import this directly — use `@seamline/cli` or `@seamline/mcp`, which already depend on it. Import it directly only if you are building a new extractor or another tool that needs to construct or validate graph facts against the same contract.

It exports the full contents of `./contract.ts`: node and edge kind enums, domain/range signature tables, sensitivity defaults, provenance ordering, and the identity helpers (`{repo}:{kind}:{canonicalName}`) that every other package uses to construct ids.

**Stability tier: two tiers live in this one package, and they move independently.**

- The **code** (this package's exports) is **library surface**: published, importable, documented as unstable below 1.0.
- The **specification** it mirrors (`ontology/seamline.yaml`, the canonical SIF serialization, and the contradiction catalog X1–X10) is a separate **specification surface**: CC-BY-4.0, versioned independently of the code, and adoptable without adopting the code at all. Breaking the ontology requires the evolution test in v3 §7 to flag it and a major bump to carry it.
