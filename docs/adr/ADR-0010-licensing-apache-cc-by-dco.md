# ADR-0010: Apache-2.0 for code, CC-BY-4.0 for the specification, DCO for contributions

- **Status:** Accepted
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §10, §10.1, §10.2
- **Council findings:** L1 (CRITICAL, licensing lens; also v3 §10.1), L4 (HIGH), H15 (HIGH, DevEx L-1). Supporting record: `docs/audit/2026-08-29-license-verification.md`.
- **Status of implementation (2026-11-10):** the licences, the DCO check (the `dco` job in `.github/workflows/ci.yml`) and the transitive allow-list (`pnpm gate:license`, `scripts/license-gate.mjs`) are in place. Five statements in this record differ from the repository. (a) There is no `LICENSE-ontology` file. The CC-BY-4.0 terms for the ontology are stated in `NOTICE` (section 2), in `ontology/README.md`, and in the SPDX header of `ontology/seamline.yaml`; `LICENSE` is the Apache-2.0 text. (b) `SPDX-License-Identifier` is not at the top of every source file: on this date 58 of the 606 TypeScript files under `packages/*/src` carry it, and no gate checks for it. (c) `THIRD-PARTY-NOTICES.txt` is generated from the installed dependency tree by `node scripts/license-gate.mjs --write-third-party-notices`, not from the SBOM; the CycloneDX SBOM is generated separately in `.github/workflows/release.yml`. (d) No check asserts that an MPL-licensed file is unmodified in-tree. `scripts/license-gate.mjs` allows `MPL-2.0` as a dependency licence and requires a notice for it, and that is the whole mechanism. (e) The only artefact generated from `ontology/seamline.yaml` is `docs/reference/ontology.md` (see `ontology/README.md`). On the `CODE-DERIVED` case named in Decision 4: the project it refers to is not published, and the outcome recorded for this repository is `NOTICE` section 4, which states that no source code from another project is incorporated and that every prior-art row is `SPEC-COMPATIBLE`.

## Context

The licensing lens verified every claim in v2's prior-art and licensing sections against sources and found the document **wrong or stale on 14 rows**. The corrections are applied in v3 §10.2 and are not re-litigated here. One finding, however, is not a correction to a row; it is a defect in how the document reasoned about licences at all, and it is the reason this ADR exists.

### L1: the defect no allow-list can catch

**v2 never distinguished implementing a published format from copying source, and Apache-2.0 code cannot be relicensed as MIT.**

v2's prior-art survey used "adopt", "borrow", and "reuse" interchangeably across nine Apache-2.0 projects. Those verbs describe two completely different acts:

- Adopting FINOS CALM's _schema_, or Backstage's _vocabulary_, is **spec-compatible reimplementation**. It is fine, and it is the whole basis of interoperability.
- Vendoring another project's merge driver, or its intel modules, is **code derivation**, and it carries the upstream licence into this repository with it.

Under an MIT project licence the second act is a licence violation, and **no `license-checker` allow-list detects it**, because the offending code does not arrive as a dependency with a manifest entry. It arrives as a copy-paste. This is the FalkorDB class of error (a dependency whose licence would have made the package undistributable, caught before any code existed) in a subtler and much harder to detect form.

A related finding shows why transitive checking is not optional: v2 chose `graspologic` specifically to avoid GPL-licensed `leidenalg` and `igraph`, and `graspologic` pulls `gensim`, which is **LGPL-2.1-only** (L4). The diligence was real; the transitive check was not done, and v2's own exclusion list was violated on first install.

### H15: MIT gives no name to defend

The DevEx lens raised a separate problem with MIT: it offers no trademark hook. For a project whose name was already the subject of a collision finding (H1, which is why the project is Seamline and not Atlas), and whose only distribution channel is search, that matters. MIT also offers no patent grant, and no open-core boundary against a funded incumbent absorbing the ontology and interoperability mappings and shipping hosted first.

## Decision

**Apache-2.0 for code. CC-BY-4.0 for the ontology and specification text. DCO for contributions. Every prior-art row tagged `SPEC-COMPATIBLE` or `CODE-DERIVED`.**

### 1. Apache-2.0 for code

Chosen over MIT for three reasons specific to this project:

- **The express patent grant** (§3), which MIT does not have.
- **The §6 trademark reservation**, which is the only hook available to defend a new project name. Given H1, that is not theoretical.
- **It matches every peer this project interoperates with**: FINOS CALM, Backstage, Cartography, OpenLineage are all Apache-2.0. This is the load-bearing reason, and L1 is why: the real licence risk here is code-derivation from exactly those projects. Under Apache-2.0, a `CODE-DERIVED` row is a compatible inbound licence with a NOTICE obligation. Under MIT it is a violation.

Apache-2.0 §4(d) obligations are met mechanically: a generated `THIRD-PARTY-NOTICES` file, produced in CI from the CycloneDX SBOM. `SPDX-License-Identifier: Apache-2.0` at the top of every source file.

### 2. CC-BY-4.0 for the ontology and specification

`ontology/seamline.yaml`, its generated artefacts, and the specification text are CC-BY-4.0 and **versioned separately from the tooling** (`ontology/README.md`). A vocabulary that others can adopt without adopting our code is worth more than one they cannot, and a code licence is the wrong instrument for a document.

### 3. DCO, not a CLA

Contributions are certified with `git commit -s` under Developer Certificate of Origin 1.1. For a solo maintainer this is the low-friction correct choice; a CLA measurably depresses drive-by contribution and only pays off if relicensing or selling an exception is a live option. **This is a one-way door in one direction only**: a CLA must be taken from day one, because retrofitting one across an existing contributor base is close to impossible. The decision is therefore explicitly that no commercial relicensing path is being reserved.

### 4. The `SPEC-COMPATIBLE` / `CODE-DERIVED` tag, and the gates

- **Every prior-art row carries one of the two tags, defaulting to `SPEC-COMPATIBLE`.**
- A `CODE-DERIVED` row requires a **recorded licence-compatibility decision plus NOTICE propagation before any code lands.** Not at release; before it lands.
- This applies to the one concrete case already identified: an earlier internal project's parsing and edge-resolution code were candidates for a targeted lift, and that project's own claim that GitNexus was "mechanism studied, no code reused" must be **confirmed against this standard** before any of it ships publicly. An internal document's assertion is not evidence for a public release.
- **Allowed (runtime and build):** MIT, Apache-2.0, BSD-2/3, ISC, CC0, Unlicense, 0BSD, Zlib, PostgreSQL, MPL-2.0 (unmodified dependency only, with notice).
- **Excluded:** GPL/AGPL/LGPL-linked, SSPL, BSL and source-available, PolyForm, CodeQL CLI terms.
- **Enforced from commit one** by `pnpm gate:license` plus a CycloneDX SBOM of Seamline itself. Not retrofitted. The allow-list must resolve **transitively**, which is the direct lesson of L4.
- "MPL-2.0 unmodified dependency only" is given a mechanism rather than left as a phrase: CI asserts that no MPL-licensed file is modified in-tree, since modifying one triggers MPL §1.10 and pulls those files under MPL.

## Consequences

### Positive

- The permissive licence is what makes Seamline embeddable inside a Backstage plugin, an IDE extension, or another vendor's agent framework, which is the only distribution path available to a project like this. Three lenses attacked the licence policy as compliance theatre and it held every time.
- Apache-2.0 makes inbound code from the Apache-2.0 peer projects legally clean, converting L1 from a violation risk into an attribution obligation with a generated file behind it.
- The trademark reservation gives the name a defence, which is worth something precisely because the naming problem already bit once.
- The two-tag discipline turns an unbounded question ("did we copy anything?") into a per-row artefact with a recorded decision, reviewable in a pull request.
- DCO keeps the contribution barrier at one command-line flag.

### Negative

- **Apache-2.0 is more verbose than MIT**: a LICENSE file, a NOTICE file, per-file headers, and a §4 obligation on redistributors. Some downstream consumers with MIT-only allow-lists will decline it, and that is a genuine, if small, distribution cost.
- **The tag discipline is manual and therefore fallible.** Nothing mechanically detects that a function was pasted from another project; the control is a reviewer's judgment plus a recorded decision. This is the weakest control in the entire decision record, and it is weak against exactly the finding that produced it. It is stated as a limit rather than dressed up.
- **DCO closes the relicensing door.** If an open-core or dual-licence model ever becomes attractive, it will require contacting every contributor. That is accepted now, in writing, so it is not discovered later.
- **Two licences in one repository** invites confusion about which file is under which. A `LICENSE` file, a `LICENSE-ontology` file, per-file SPDX headers, and an explicit statement in `ontology/README.md` are all required, and even so some users will get it wrong.
- The transitive allow-list will occasionally block a dependency the maintainer wants, for a licence deep in its tree that its own authors did not think about. That is the gate working, and it will still be annoying.
- CC-BY-4.0 requires attribution on derivative vocabularies, which is mildly less permissive than CC0 and could deter an adopter who wants to fold the vocabulary into their own spec silently. That is the intended trade: attribution is the point.

## Alternatives considered

**MIT for everything (v2's choice).** Rejected on three independent grounds: no patent grant; no trademark hook to defend a name that already had a collision problem (H15, H1); and, decisively, **Apache-2.0 code cannot be relicensed as MIT**, so under MIT every `CODE-DERIVED` row from the Apache-2.0 peer set is a violation rather than an attribution obligation (L1).

**AGPL or SSPL to prevent a hosted competitor.** Rejected: it destroys the distribution model outright. Nobody embeds an AGPL library in a Backstage plugin or an IDE extension, and this project's own dependency allow-list excludes both licences, so adopting one would make the project fail its own gate.

**Open-core: permissive core, commercial extensions.** Rejected for v0.1 and not foreclosed at the technical level, since the `profile` field (ADR-0001) is where such a boundary would naturally fall. It is foreclosed at the _licensing_ level by choosing DCO over a CLA, and that trade is made deliberately: contribution volume now is worth more than a commercial option later, for a project whose primary risk is nobody using it.

**CC0 for the ontology.** Rejected: CC-BY costs an adopter one attribution line and gives a new project the one thing it cannot buy, which is provenance in other people's documents. LinkML's own model and runtime being CC0 does not oblige us to match it.

**A CLA (individual or corporate).** Rejected per the reasoning above. Recorded here explicitly because it is the one decision in this ADR that genuinely cannot be reversed later.

**Version the ontology together with the tooling under one licence.** Rejected: the vocabulary is meant to be adoptable by people who will never run this code, and a code licence on a specification is a signal that it is not really meant to be adopted. See `ontology/README.md` for the versioning consequence.
