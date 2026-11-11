# ADR-0008: A scoped GitHub Actions exception for open-source repositories

- **Status:** Accepted
- **Date:** 2026-08-29
- **Scope:** Open-source repositories only. **Not the platform.**
- **Design reference:** `docs/design/v3.md` §8
- **Council finding:** L10 (HIGH, licensing lens), raised again in §6 of the council review as one of three findings rising to CRITICAL level. Supporting record: `docs/audit/2026-08-29-license-verification.md` §5.
- **Standing rule this modifies:** the maintaining organization's standing infrastructure policy (internal, not published), "ArgoCD only, never GitHub Actions. `.github/workflows/` is a forbidden path."
- **Reader's note (2026-11-10):** the standing rule is a policy of the maintaining organization for its own private infrastructure. It is not published, and the Context section quotes all of it that this record relies on. The part of this record a reader can check without it is the npm provenance constraint quoted under Context and the two workflows in `.github/workflows/`.
- **Status of implementation (2026-11-10):** this repository has two workflows. `.github/workflows/ci.yml` runs the build, lint, tests, the license, version, ontology, determinism and dogfood gates, the internal-identifier scan, and a DCO sign-off check on pull requests. `.github/workflows/release.yml` runs the release gates, generates a CycloneDX SBOM, publishes with `--provenance`, and then checks that every published package carries an attestation; release 0.1.0 was published through it on 2026-11-10. Neither workflow deploys anything, and the only secret either one reads is the npm publish token. Three things in this record differ from the code. (a) Limit 3 prefers OIDC trusted publishing over a stored npm token: `release.yml` authenticates with a stored token (`NPM_TOKEN`) and uses `id-token: write` only to mint the provenance attestation. (b) "Structural consequence for the product": there is no `packages/ci`, no `ci-core` / `ci-github` / `ci-argo` split, and no GitHub Action shipped for adopters; the gates are the scripts in `scripts/`, called from the workflows and from `pnpm verify`. (c) Limit 4: there is no Postgres adapter (see the note in [ADR-0004](ADR-0004-sqlite-relational-storage.md)), so the second pipeline it describes does not exist and there is one CI plane, not two.

## Context

Zylver's standing operational rule is unambiguous and has been enforced without exception: all deployment and CI orchestration runs in-cluster via ArgoCD, Argo Workflows, and Argo Events. `.github/workflows/*.yml` is a forbidden path. Workflow YAML is never created, edited, or re-enabled, and existing files are surfaced for removal rather than maintained.

That rule was written for the platform, where it is correct. It produces a specific, verified failure on a public npm package, and the failure is not one that can be engineered around.

**npm provenance attestations are issuable only from GitHub Actions or GitLab CI/CD, and only on cloud-hosted runners.** Self-hosted runners are explicitly unsupported. This is npm's documented position, not an inference:

> "To publish a package with provenance, you must build your package with a supported cloud CI/CD provider using a cloud-hosted runner."
> https://docs.npmjs.com/generating-provenance-statements

Trusted publishing via OIDC reached general availability on 2025-07-31 for GitHub Actions and GitLab, and neither list includes a self-hosted or in-cluster option. **Argo Workflows cannot produce npm provenance**, and no amount of configuration changes that, because the attestation is signed against the CI provider's own OIDC identity.

Under an Argo-only policy, therefore, a published Seamline package **cannot carry provenance at all**. The available fallback is cosign signatures plus a published SBOM, which is genuinely useful for a determined verifier and which **no npm client verifies by default**. For a new supply-chain-security-adjacent tool from an unknown publisher, shipping without the one attestation the ecosystem checks automatically is a material adoption cost.

There is a second, weaker argument that on its own would not have been sufficient: a public OSS project with no visible CI and no PR checks has near-zero external contributor trust. Contributors judge a project by whether their pull request gets a green check. That argument is real but it is secondary, and it is recorded as secondary so that this exception is not later cited to justify workflows on grounds of convenience.

## Decision

**A scoped exception to the ArgoCD-only rule is granted for open-source repositories. Seamline may use `.github/workflows/`. The exception is to be folded into the open-source project archetype rather than treated as a one-off.**

### What the exception permits

For repositories that are **public, open-source, and publish to a public package registry**:

- **Public CI in `.github/workflows/`:** lint, typecheck, unit tests, property tests, conformance suite, the determinism gate (ADR-0009), the license allow-list gate (ADR-0010), SBOM generation, the dogfood gate, and **npm publish with provenance**.
- Pull-request checks visible to external contributors on their own forks.

### What the exception does not permit

The limits are the substance of this ADR, and they are enumerated rather than implied:

1. **It does not apply to the platform.** The organization's multi-tenant SaaS products and every private repository remain ArgoCD-only. `.github/workflows/` stays a forbidden path there. This exception may not be cited as precedent for a platform repo.
2. **It does not apply to deployment.** No workflow in an OSS repo may deploy to Zylver infrastructure, reconcile a cluster, or touch a Kubernetes resource. Deployment remains ArgoCD reconciling from `main`; Cloudflare Pages deploys remain the per-project Argo Sensor (an internal deployment-event pipeline).
3. **It does not permit Zylver secrets in GitHub.** No SOPS age key, no `KUBECONFIG`, no cloud credential, no production secret-store credential. The only credentials permitted are those scoped to publishing this package and nothing else, and OIDC trusted publishing is preferred over a stored npm token specifically because it holds no long-lived secret. Finding S6 is the reason this limit is stated explicitly: a fork's pull request runs attacker-authored code in the CI job, so a CI job holding production credentials is an arbitrary-execution path into the platform.
4. **It does not apply to the internal adapter path.** The Postgres-adapter pipeline runs in **Argo Workflows and Argo Events**, following the maintainers' own deployment-event pipeline's Sensor precedent, and it runs the same gates. Two planes, one gate definition.
5. **It is not a convenience exception.** It exists because provenance is unobtainable otherwise. A future OSS repo that does not publish to a public registry does not automatically inherit it, and "GitHub Actions is easier" is not a qualifying reason.

### Structural consequence for the product

`packages/ci` ships the GitHub Action as a **product artifact for adopters**, split `ci-core` / `ci-github` / `ci-argo`, so the adapter is not GitHub-first. This resolves the internal contradiction the licensing lens flagged in v2 §7: shipping a GitHub Action as a deliverable for users is defensible, and wiring it into a _Zylver_ repo's own CI was not. Now one of those is permitted and the other still is not, and the split makes the difference legible in the package layout.

## Consequences

### Positive

- Published packages carry npm provenance, which is the one supply-chain attestation npm clients surface by default. For a project whose subject matter is verification, shipping unverifiable artifacts would have been a credibility problem as much as a security one.
- External contributors see green checks on their pull requests, on infrastructure they can read and reproduce.
- The exception is written down, scoped, and dated, so its limits are auditable. An undocumented exception becomes a precedent by accident; a documented one has to be argued for again.
- Splitting `ci-core` / `ci-github` / `ci-argo` means the gate logic has exactly one definition and two thin adapters, so the two planes cannot drift into testing different things.

### Negative

- **Two CI planes to maintain**, with the standing risk that the GitHub plane and the Argo plane diverge. The `ci-core` split mitigates this; it does not eliminate it.
- **A weakening of a bright-line rule.** "Never" is enforceable by a grep; "never, except for open-source repositories that publish to a public registry" is not. That is a real loss in enforceability and it is the main cost of this decision.
- Dependency on a vendor whose policies Zylver does not control. If GitHub changes its Actions terms or pricing, the publish path changes with it.
- Every future repository now requires a classification decision (platform or OSS) before its CI is set up, and a misclassification puts workflow YAML somewhere it must not be. Folding the exception into the OSS archetype is the mitigation: the archetype decides, not the individual setting up the repo.
- The CI configuration itself becomes a review-sensitive surface. A pull request that edits `.github/workflows/` is a privilege-relevant change and must be reviewed as one.

## Alternatives considered

**Keep the Argo-only rule and ship without provenance, compensating with cosign and an SBOM.** Rejected, and this was the closest alternative. Cosign signatures plus a CycloneDX SBOM are genuinely stronger evidence than provenance for anyone who checks. Almost nobody checks: no npm client verifies cosign by default, whereas provenance appears on the package page and in `npm audit signatures`. The security value is real and the adoption value is close to zero, and adoption is what this project is short of.

**Use GitLab CI on cloud-hosted runners for the publish step only.** Rejected. It technically satisfies npm and technically avoids GitHub Actions, so it is a lawyerly compliance with the rule while violating its intent, and it adds a third CI plane and a mirroring step for one job. If the objection to GitHub Actions were about GitHub specifically this would be the answer; the objection is about out-of-cluster CI, which GitLab equally is.

**Publish manually from a maintainer's workstation.** Rejected: no provenance, no reproducibility, a long-lived npm token on a laptop, and a bus factor of one on the release process.

**Do not publish to npm at all; distribute from a Zylver-hosted registry.** Rejected: it defeats the distribution model. An embeddable Apache-2.0 library that is not on npm is not embeddable in practice.

**Grant a blanket exception rather than a scoped one.** Rejected: the platform reasons for the ArgoCD-only rule (in-cluster secrets, no external CI holding production credentials, deployment through a single reconciler) are undamaged by this finding and remain correct. The exception is exactly as wide as the problem that forced it.
