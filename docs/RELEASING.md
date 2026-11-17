# Releasing

How a Seamline release is cut, what the release workflow does, and how anyone can verify a published package. The mechanism is [`.github/workflows/release.yml`](../.github/workflows/release.yml); where this page and that file disagree, the file is right.

## What a release is

- Twelve packages are published together under one version: `@seamline/align`, `cli`, `contradictions`, `core`, `extract-change`, `extract-code-ts`, `extract-contracts`, `extract-data`, `infer-join`, `mcp`, `ontology` and `security`. `@seamline/eval` and `@seamline/integration` are private and are never published.
- A release is an annotated git tag `vX.Y.Z`, and the packages on npm are built from that tag and published by the release workflow, not from a workstation.
- The workflow does not create a GitHub release, and `CHANGELOG.md` is written by hand.

## Cutting a release

1. **Set the version everywhere.** The twelve `package.json` files and the three version literals compiled into the code (`packages/cli/src/version.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/bin.ts`) must all carry the new version. Check it:

   ```bash
   node scripts/version-check.mjs --expect X.Y.Z
   ```

   `pnpm gate:versions` runs the same script without `--expect`, in `pnpm verify`, in CI and in the release workflow.

2. **Update `CHANGELOG.md`** by hand: move the `[Unreleased]` entries under the new version and date.

3. **Run the local gates and the publication scan.** `pnpm verify` runs the leak scan in its default mode, where an open release-readiness item is a warning; `--publish` is the mode the release workflow runs, where it fails:

   ```bash
   pnpm verify
   node scripts/internal-leak-scan.mjs --publish
   ```

4. **Merge to `main` through a pull request**, with the required checks green ([CONTRIBUTING.md](../CONTRIBUTING.md#branch-protection)).

5. **Tag a commit that is contained in `main`, with an annotated tag, and push the tag:**

   ```bash
   git merge-base --is-ancestor <commit> origin/main && echo "on main"
   git tag -a vX.Y.Z -m "Seamline X.Y.Z" <commit>
   git push origin vX.Y.Z
   ```

   The workflow starts on any pushed tag that matches `v*`. Its first step after the checkout runs the same check as the first command above and fails the run when the tagged commit is not contained in `origin/main`. A release from a maintenance branch that `main` does not contain is refused by the workflow by design.

6. **The `verify` job runs again on the tagged commit:** the check that the commit is contained in `main`, install from the lockfile, build, lint, test, the license (with `THIRD-PARTY-NOTICES.txt`), versions, pack, ontology, ontology reference, determinism and dogfood gates, and the publication leak scan. It then generates a CycloneDX SBOM and fails unless the tag equals `v` plus the version in `packages/cli/package.json`. That is every gate of `pnpm verify`; none is left out.

7. **Approve the `publish` job.** It runs in the `npm-publish` environment, which accepts only `v*` tags and waits for one required reviewer. The reviewer may approve a run they started, so with a single maintainer this is a deliberate pause and not an independent review ([THREATMODEL.md](../THREATMODEL.md), R13).

8. **The job publishes.** It installs and builds again, then runs:

   ```bash
   pnpm publish --recursive --access public --provenance --tag next --no-git-checks
   ```

   Authentication is an npm token stored as the environment secret `NPM_TOKEN`; for 0.1.0 it was a short-lived granular token. A move to npm trusted publishing (OIDC, no stored token) is planned and not done. The provenance attestation is produced from the job's `id-token: write` permission.

9. **Verify from outside CI**, as described under [Verifying a release](#verifying-a-release). The job's own last step does the same check from inside the run.

## Manual runs

The workflow can also be started by hand (`workflow_dispatch`) on a branch or a tag. It takes no input, and a manual run never publishes: the Publish step and the provenance check run on a tag push only.

- **On a branch,** the `verify` job runs on that branch, without the two checks that are about a tag (contained in `main`, tag equals version). The `publish` job is then refused by the `npm-publish` environment, which admits only `v*` tags, so no step of it runs, the publish token is not read, and the run ends as failed at that job. Use this to run the release gates and build the SBOM on a branch.
- **On a `v*` tag,** the `verify` job runs the same way. After the reviewer approves it, the `publish` job installs, builds and runs `pnpm publish --recursive --access public --tag next --no-git-checks --dry-run`, which packs every package and uploads nothing.

To see what would be packed without starting a workflow, run `pnpm gate:pack` locally.

## Dist-tags

The workflow publishes under the dist-tag `next` only, and has no step that moves `latest`. On the first publish of a package the npm registry sets `latest` as well, whatever tag was asked for, so after 0.1.0 both tags point at 0.1.0:

```bash
npm view @seamline/cli dist-tags   # { latest: '0.1.0', next: '0.1.0' }
```

For later versions `latest` stays where it is until a maintainer moves it with `npm dist-tag add <package>@<version> latest`, once per package.

## Known behaviours

- **The registry needs time to serve a new package.** In the 0.1.0 run the provenance check started in the same second the publish finished and failed with `404 Not Found` for a package that had just been published; seen from outside CI, all twelve package documents were visible about 5 minutes after the Publish step ended, and a clean install of all twelve succeeded after about 8 minutes (the registry's own timestamps for the versions fall within 3 minutes of the publish). In the same run, a first attempt had failed earlier at the Publish step with an authentication error and published nothing; the job was re-run once. The packages were published correctly and were verified afterwards from outside CI, but the run for `v0.1.0` is recorded as failed. Until the workflow waits for the registry, expect this on a first publish and verify from outside CI.
- **Do not re-run the `publish` job after its Publish step has succeeded.** A published version cannot be changed or published again, so a re-run cannot repair anything; it only uses the publish credentials one more time. If only the verification step failed, verify from outside CI.
- **If the Publish step itself fails,** find out which packages exist at that version (`npm view <package>@<version> version`) before doing anything else.
- **Each package also lists a version `0.0.0-stage`.** `npm view @seamline/cli versions` prints `[ '0.0.0-stage', '0.1.0' ]`. The registry created that entry during the first publish; its metadata describes it as a "Temporary package placeholder for staged publishing" and marks it `stub: true`. It carries no provenance attestation, no dist-tag points at it, and it is not a Seamline release. Do not install it.
- **Never unpublish.** A version that should not be used is deprecated, and the fix ships as a new patch version: `npm deprecate <package>@<version> "<message>"`.
- **The SBOM is a workflow artifact, not a release asset.** It is attached to the release run as `seamline-sbom` and GitHub deletes it after 90 days (for 0.1.0, on 2027-02-07).

## Verifying a release

These commands need no access to this repository. They were run against 0.1.0 on 2026-11-10 from a machine that is not part of CI.

In a project that has `@seamline` packages installed:

```bash
npm audit signatures
```

npm checks the registry signature of every installed package and the provenance attestation of every package that has one, and fails if any is invalid. After `npm install @seamline/cli@0.1.0` in an empty project it reported 23 packages with verified registry signatures and 15 with verified attestations (the twelve `@seamline` packages are among the 15).

For one package:

```bash
npm view @seamline/cli@0.1.0 dist.attestations
```

This prints the attestation URL and `predicateType: 'https://slsa.dev/provenance/v1'`. The URL serves the attestation bundle. The SLSA provenance statement in it (base64 JSON in `dsseEnvelope.payload`) must name:

| Field                                      | Value for an official release                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `workflow.repository`                      | `https://github.com/zylver-solutions/seamline`                                        |
| `workflow.path`                            | `.github/workflows/release.yml`                                                       |
| `workflow.ref`                             | `refs/tags/vX.Y.Z`, matching the package version                                      |
| `resolvedDependencies[0].digest.gitCommit` | the commit that tag points at (for 0.1.0: `af1d3aca53a6b25a3d1539852bd685e12f783a51`) |

A `@seamline` package with no attestation, or one whose attestation names another repository, workflow or ref, is not an official release. Please report it through [SECURITY.md](../SECURITY.md).

Provenance says which repository, workflow and commit built a package. It does not say the commit was reviewed by a second person; see [THREATMODEL.md](../THREATMODEL.md), R13.
