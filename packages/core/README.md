# @seamline/core
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

Seamline's storage, identity, merge, traversal and evidence infrastructure. The existing code-analysis graph APIs remain available from the root export. The new semantic foundation is available at `@seamline/core/semantic`.

Both library surfaces are pre-1.0. See [the semantic foundation guide](../../docs/semantic-engine.md) for supported operations, runtime limits, extension examples and compatibility rules.

The semantic API includes:

- `CompiledRegistry`: immutable, dependency-checked profiles, runtime schemas and reusable facets.
- `SemanticEngine`: SQLite universes/worlds/timelines, temporal state, branches, atomic commands, bounded queries, history and allowlisted export.
- `worldProfile`, `inventoryProfile`, `authoringProfile`, `softwareProfile`: ready-to-compose domain building blocks.
- `legacyCodeProfile`, `prepareLegacyImport`, `legacyScopeStatus`, `legacyIsFact`: a redacted bridge from existing code intelligence, retaining evidence and availability.

This is trusted local embedding. Applications supply authentication/authorization at their host boundary. Profile handlers are installed trusted code, not executable input accepted from a remote caller. No new runtime dependencies are introduced.
