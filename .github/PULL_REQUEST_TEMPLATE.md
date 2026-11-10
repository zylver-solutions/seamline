## What this changes

<!-- One or two sentences. The diff already says what changed; say why. -->

## Why

<!-- The problem this solves. Link the issue: Fixes #123 -->

## How it was verified

<!--
Name the test that fails before this change and passes after. If there isn't
one, say why not. "Ran it locally and it looked right" is not verification;
this project's entire thesis is that presence is not proof.
-->

- [ ] `pnpm verify` passes locally (typecheck, lint, test, and the license, ontology, ontology reference, determinism, versions, pack and dogfood gates)
- [ ] `node scripts/internal-leak-scan.mjs` exits 0 (CI runs it; `pnpm verify` does not)
- [ ] A test asserts the **outcome**, not that a function exists
- [ ] If this adds or changes a detector: a fixture pair (one that fires, one that does not) plus the meta-test
- [ ] If this touches extraction or serialization: `pnpm gate:determinism` passes

Anything you could not run, and why:

<!-- Be explicit. A reviewer working out on their own that a gate was skipped is a worse outcome for everyone. -->

## Type of change

- [ ] Bug fix (no behaviour change beyond the fix)
- [ ] New feature
- [ ] Breaking change (`feat!:` / `BREAKING CHANGE:` footer, with a migration note)
- [ ] Ontology change (`ontology/seamline.yaml` or the generated vocabulary)
- [ ] Documentation only
- [ ] Build, dependencies, or CI

## Surface checks

Tick what applies, or write "n/a". These map onto the controls in
[THREATMODEL.md](https://github.com/zylver-solutions/seamline/blob/main/THREATMODEL.md); a reviewer will look at them
regardless, so filling them in makes the review faster rather than slower.

- [ ] **Dependencies.** No new runtime dependency. If there is one, I named it, its exact SPDX license, and why the standard library will not do.
- [ ] **Copied code.** Nothing in this change was copied or adapted from another codebase. If it was, I named the upstream and its license, because no allow-list gate can detect a copy-paste.
- [ ] **Export.** This does not widen what leaves the store by default. Export is default-deny and stays that way.
- [ ] **Query surface.** This adds no query language, expression evaluator, or raw query tool, and no unbounded traversal.
- [ ] **Untrusted text.** Any new third-party-sourced string is tagged `untrusted` and stays delimited when it reaches agent context.
- [ ] **Network.** No extractor makes a network call.
- [ ] **UNKNOWN handling.** No new path reports a negative finding from a scope that did not `PASS`.
- [ ] **Design.** This does not contradict `docs/design/v3.md`. If it does, I opened an issue to change the design first, linked above.

## Developer Certificate of Origin

- [ ] **Every commit in this branch is signed off** (`git commit -s`), and I certify the [DCO](https://developercertificate.org/).

<!--
Forgot? Fix the whole branch:  git rebase --signoff <base branch>
Seamline uses the DCO, not a CLA. You keep your copyright.
-->
