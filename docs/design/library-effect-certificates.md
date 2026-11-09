# Library effect certificates

Status: accepted design, for the library-effect proof of [`ansi-regex-effects.md`](../evaluation/ansi-regex-effects.md). Implementation may rely on this proposal only after its design change merges. A certificate design supplies no implementation, real-source firing, independent review, qualification or release credit.

## Consumer and unchanged claim

The consumer is the complete source-effect proof for the request parser, validator and generated-client binding in the X7 producer work. The shipped defect, exact development parent/fix, operator triage window and required name/description proof remain those of [X7](x7-upper-length.md). This admits provenance work for that binding, not a general module interpreter or a new detector.

The fact still means that a source-proved validated input permits strings beyond the declared storage bound along the extracted write binding. An import-origin check cannot establish that fact. Neither can an apparently pure exported function certify its module's initialization. No new conditional, profile-specific or heuristic fact may silently replace the existing claim, complete-binding flags or examined fixed negative.

In the draft of 2026-10-24, the exact required parent and fix both complete with X7 UNKNOWN and zero findings, first refusing `cypress.config.ts:1`. A separate diagnostic census examines the first source site of each of 83 bare static runtime-import spellings: 5 pass import admission and 78 refuse, comprising 69 library-effect refusals and 9 native-capability refusals. This is representative-site evidence, not all-site safety or a dependency count. The production inventory contains 838 source files. These measurements authorize no import.

## A certificate proves effects, not a name

Additional library permission requires one reviewed, closed certificate. The engine ships its data with the implementation; inspected repositories cannot supply certificates, code, callbacks, plugins or configuration that grants permission. Missing or malformed evidence withholds the binding. There is no version-only, symbol-name, familiar-package or unrelated-basename fallback.

Each certificate must state all of these:

1. **Artifact identity.** Exact package/version, complete published integrity, artifact SHA256, primary-source locations and hashes of every source member on which the proof relies. Record license provenance without copying implementation. Installation, package execution and runtime downloads are not part of analysis.
2. **Resolved entry.** Exact package subpath, export condition, source member and loader/resolver prerequisites. Import syntax alone does not prove an `import` condition: transpilation, conditional exports, package type and the actual admitted loader must be accounted for. An unknown or customized loader withholds. A CommonJS proof cannot be reused for an ESM entry, or conversely, without its own evidence.
3. **Initialization closure.** Every possible initialization path, executed import/require, top-level call, getter and initialization callback relevant to the entry. Conditions on environment or process state require proved values or all possible branches. A safe accepted export does not erase another initialization path. Dynamic code generation needs a separately reviewed closed construction proof; code or regular expressions from the input are never executed.
4. **Dependency closure.** Every resolved dependency slot used by initialization or the accepted API, including peer/optional contexts, subpaths and relevant export conditions. Each slot is either a proved source member of the same artifact, another closed reviewed certificate, or an existing applicable native summary. A dependency cannot certify itself or close a cycle by repeating an unproved assertion. Cycles remain UNKNOWN unless a separate bounded proof establishes the whole component.
5. **Allowed uses.** Exact exports and operations, argument/value provenance, callback behavior, returned identities, aliases, mutation and escape restrictions. An initialization-only summary grants no API permission. A pure-call summary grants no initialization permission. Check every runtime use in the complete inspected source inventory, including re-exports, dynamic loads and disjoint branches.
6. **Noninterference.** A source argument explaining why initialization and every allowed use preserve the validator's relevant semantics, successful parsing and returned data, unchanged forwarding, client lineage/cache identity and framework invocation proof. Account for shared intrinsics, prototypes, library-private constructors, ambient capabilities, source callbacks, native execution, loaders and source/artifact emission. An unused capability may be excluded only by a proved noninvocation and nonescape argument.

Source hashes and integrity bind a reviewed semantic argument to bytes. They do not automatically prove that argument. The six source councils must review the argument and its counterexamples as well as the table equality. Existing manually reviewed summaries do not acquire this certificate's stronger claims merely by being represented in its data format; migrating one requires its own complete evidence and controls. All permission paths for a migrated artifact must use its certificate; a refusal cannot fall back to a legacy summary.

## Lock and resolver verification

Verify the whole declared resolved graph against the certificate before granting its permission. Bind a dependency to its actual parent snapshot and full peer/optional resolution context, not merely the first package with a matching name or a version with its peer suffix removed. Verify every required package resolution's complete integrity and every expected edge. Unknown protocol, archive/directory substitution, aliases, patches, package extensions, overrides, hooks, resolver maps, ambiguous snapshots, missing members or unexpected relevant edges withhold. An integrity on the root alone cannot vouch for a replaced transitive package.

All inputs remain repository-confined, capped reads under the existing manifest. No network, installation or loading of inspected package code occurs. Published artifacts and primary sources may be researched separately during engineering review; production consumes only its compiled reviewed certificate data and the inspected repository's metadata/source. No downloaded artifact or copied application becomes a new implicit input.

The resolved-entry proof and accepted-use proof share the same source and dependency identities. Preserve case, subpath, loader conditions and context through aliases and memoization. Type-only erasure follows the existing rules; an inline type-only specifier that leaves a runtime load still needs initialization proof.

## Complete source world and bounds

The complete bounded repository inventory remains mandatory. A tool directory, test suffix, conventional configuration filename or disconnected-looking basename cannot exclude code or imports. This design grants no execution-phase exception. A future phase proof would need its own design pass covering all entries, shared state, hidden callers and cross-phase source/artifact writers; it must preserve the existing semantic claim, authority and real-source acceptance.

The certificate verifier is deterministic data checking, not a plugin evaluator. Add caps of 1024 artifact/context nodes, 4096 dependency edges and 4096 source-member records per proposed certificate closure. The serialized reachable certificate data is capped at 512 KiB. Exceeding any cap is UNKNOWN. These are additional caps, not replacements for the existing 10000 binding-slice syntax limit: charge every visited certificate node, dependency edge and source-member record to that budget, including work replayed from caches. Do not silently omit optional branches to fit.

Retain two forwarding boundaries, four client-initialization functions, 32 binding-slice modules, 64 resolutions per module, the complete 20000-entry inventory, 8 MiB/file, 8 MiB/2048-entry source cache, 512 MiB V8 heap, polled 768 MiB RSS threshold with existing runtime headroom and 120-second child deadline. Certificate verification cannot raise a limit, turn inventory membership into declaration proof, clear a latched exhaustion or make a partial closure current. Tables and graph walks must have stable ordering and cycle handling independent of filesystem and host runtime iteration.

No certificate changes natural identity inputs, declaration collision handling, property roles, tombstone selectors or current observation. A failed or unsupported certificate keeps existing facts outside current retirement authority. It cannot mint a property, clear UNKNOWN, broaden a canonical authority claim or make a detector PASS on the strength of an import check.

## Required controls and implementation acceptance

Write generic fixtures from scratch. Include an independently specified permitted artifact/entry with both a passing binding and exact facts/authority, plus controls for:

- Replaced root and transitive artifacts, missing records, wrong parent/peer/optional contexts, alternate subpaths, loader conditions, unexpected relevant edges and customization hooks.
- A pure exported function beside effectful initialization; lazy effects that are called or escape; initialization callbacks; hidden source callers; library-private and shared intrinsic mutation; native loaders/workers and emitted source.
- Conditional initialization with an unknown branch, unproved cycle, inline type runtime loads, unsupported caller, mutable alias, exhausted counts, memory/deadline failure and cache replay.
- Supported-to-unknown transitions, stable diagnostics, preserved older noncurrent facts, byte-identical extraction and path-free identity under eligible moves.

Mutate entry selection, initialization coverage, dependency identity, context matching, accepted-use closure, noninterference, budget charging and authority guards individually. Count only intended outcome assertion failures, with a passing control and restored source. A registration check, certificate-shaped object, successful import check or swallowed runtime error is not a killed mutation.

Then run production extraction/evaluation on the unchanged exact required DEV parent and fix. Show the required parent name/description contradictions with endpoint facts and binding witnesses, and their disappearance with complete examined fixed bindings. If any import, initialization, parser, validator, callback, native or other source proof still refuses, preserve that refusal and keep the X7 producer change blocked. Do not rename the target, substitute fixtures, use historical firing, infer acceptance from the first cleared refusal or call UNKNOWN an examined negative.

Require all six fresh councils, signed-off pinned-head green hosted CI and isolated-host verify, both leak scans and all-package publication dry-run. Any baseline change remains a separate reviewed PR. This proposal changes no public export, raw-query surface, external dependency, ontology or invariant. The original independent author/reviewer-account requirements, sealed partition discipline, at least 30 labelled clusters, precision at least 0.90, Wilson lower bound at least 0.75, confidence calibration and per-detector mutant recall remain unchanged. Deployment, publication and tagging still require the operator's explicit milestone instruction.
