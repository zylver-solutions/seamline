# Security policy

## Reporting a vulnerability

**Do not open a public issue, a discussion, or a pull request for a suspected vulnerability.**

There are two private routes. Use either one.

1. **GitHub private vulnerability reporting.** It is enabled on this
   repository. Open
   <https://github.com/zylver-solutions/seamline/security/advisories/new>, or
   use **Report a vulnerability** on the repository's Security tab. The report
   is visible only to you and to the repository's maintainers.
2. **Email** to <security@zylver.com>. **Ramiro Enriquez** is the sole security
   contact and confirms that he monitors that address. No PGP key is published.
   If your report requires encryption beyond ordinary email, send only a request
   for a secure channel first; do not include vulnerability details or secrets
   in that request.

Both routes reach the same single maintainer. If a report on one route is not
acknowledged within the time stated under
[Response expectations](#response-expectations), send it again on the other.

Do not substitute a public issue, discussion or pull request for a private
report.

### What to include

A report we can reproduce gets fixed faster than a report we have to interpret.

- The version (`seamline --version`) and how it was installed.
- Node version, package manager, and operating system.
- A minimal reproduction. A synthetic repository is ideal. **Do not send us your real repository, real secrets, or a real graph export.** If a real artifact is genuinely necessary, say so and wait for a secure channel; do not attach it to the first message.
- What you expected, what happened, and what an attacker gains.
- Whether you have disclosed it anywhere else, and any deadline you are working to.

---

## Response expectations

These are commitments, not aspirations. This is a small project, so they are set at a pace that can actually be met.

| Stage                                                        | Target                                               |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| Acknowledge receipt                                          | 3 business days                                      |
| Initial assessment: valid or not, and a provisional severity | 10 business days                                     |
| Fix or documented mitigation for critical and high           | 30 days from confirmation                            |
| Fix or documented mitigation for medium and low              | 90 days from confirmation, or the next minor release |
| Public advisory after a fix ships                            | within 7 days                                        |

If we are going to miss one of these, you will be told before it slips rather than after.

**Disclosure.** Coordinated, with a 90-day default from the date we confirm the report. We will publish a GitHub Security Advisory with a CVE where one applies. You will be credited by the name you choose, or not credited if you prefer. If you tell us you intend to publish sooner, we will do our best to ship in your window and will say plainly if we cannot.

**Safe harbour.** Good-faith research on your own systems, on a repository you own, or on a synthetic fixture is welcome, and we will not pursue or support legal action over it. That covers reverse engineering, fuzzing, and reporting what you find. It does not cover accessing data that is not yours, degrading a third party's service, or exfiltrating someone else's graph to prove a point.

There is **no bug bounty**. We have no budget for one and would rather say so than imply otherwise.

---

## Supported versions

| Version               | Status                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.x` (pre-1.0)       | `0.1.0`, published on 2026-11-10, is the first and only release so far. Fixes land on the latest published `0.x` only. There are no backports. |
| `1.x` (when released) | The current minor, plus security fixes on the previous minor for 6 months after it is superseded.                                              |

Seamline is pre-1.0. In practice this means: upgrade to the latest release to get a security fix. If that is not possible for you, say so in your report and we will work out what mitigation is available, but a patch release against an older `0.x` is not something we can currently commit to.

Every release is published to npm with a provenance attestation. How to check that the packages you installed are an official release is in [`docs/RELEASING.md`](docs/RELEASING.md#verifying-a-release).

---

## Known dependency advisories

These are advisories in a dependency that ship with Seamline and that we have assessed and decided to disclose rather than leave for you to find. Facts are from `pnpm-lock.yaml` and `pnpm audit --prod` at the time of writing (2026-11-05).

### `minimatch` 10.2.6: GHSA-g3hv-75wg-m249 (CVE-2026-118764), moderate

|                           |                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory                  | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), CVE-2026-118764, npm advisory 1244623, CWE-405. "minimatch has potential denial of service via globparts amplification." Severity: moderate.                                                                                                                                                           |
| Affected range            | `>=7.0.0 <11.0.1`. Patched in `>=11.0.1`.                                                                                                                                                                                                                                                                                                                                        |
| Version Seamline resolves | `minimatch@10.2.6` (the only `minimatch` in `pnpm-lock.yaml`), so it is in the affected range.                                                                                                                                                                                                                                                                                   |
| How it ships              | `@seamline/extract-code-ts` depends on `ts-morph@^28.0.0` (locked at 28.0.0), which depends on `@ts-morph/common@0.29.0`, which depends on `minimatch@^10.0.1`. The same `minimatch@10.2.6` also appears under ESLint and `@typescript-eslint` in the development toolchain; that copy is not published.                                                                         |
| Trigger                   | The flaw is in minimatch's pattern preprocessing and needs the option `optimizationLevel >= 2`. An attacker-supplied glob pattern then makes minimatch generate extra pattern entries and compare them pairwise, which consumes CPU and memory.                                                                                                                                  |
| Reachable in Seamline     | Not by default. `@ts-morph/common@0.29.0` calls `minimatch(path, pattern)` without an options argument (`dist/ts-morph-common.js`, two call sites), so it does not request `optimizationLevel >= 2`. Seamline's own source does not import `minimatch` or set that option. The effect of the flaw is resource exhaustion in the local process, not code execution or disclosure. |
| Upstream status           | A fixed `minimatch` (11.0.1) exists, but `@ts-morph/common` declares `^10.0.1`, which excludes it. On 2026-11-05 `ts-morph` 28.0.0 and `@ts-morph/common` 0.29.0 were the latest published versions, so there is no `ts-morph` release to move to.                                                                                                                               |
| What you can do           | Nothing is required for the default configuration. If you also run your own code that calls `minimatch` with `optimizationLevel >= 2` on untrusted patterns, upgrade that use to 11.0.1 or later. A package-manager override to `minimatch@>=11.0.1` for the `@ts-morph/common` dependency is possible, but we have not tested it against Seamline.                              |
| Our plan                  | Adopt a `ts-morph` release whose `@ts-morph/common` accepts `minimatch >=11.0.1` when one is published, and remove this entry in the release that does.                                                                                                                                                                                                                          |

Your install resolves its own dependency tree. Seamline's lockfile does not govern what `npm install @seamline/extract-code-ts` selects, and every `minimatch` 10.x release is inside the affected range.

---

## What is in scope

Read [THREATMODEL.md](THREATMODEL.md) first. It states what is defended and, in section 7, what is knowingly not. A report against a documented residual risk is still welcome, but it will be triaged as a design gap rather than a vulnerability.

The controls below are load-bearing. A demonstrated bypass of any of them is a vulnerability, and the severity is at least high.

- **Export default-deny.** Any way to get facts out of the store without a named allow-list profile, or to get a node past a profile that should have excluded it. `seamline export` with no `--profile` producing output is a critical.
- **Redaction bypass.** A secret value reaching the store or an export rather than being replaced by a reference. Include the shape of the value; a new credential format the scanner does not recognise is useful even though it is also residual risk R1.
- **Extractor sandbox escape.** An extractor reading outside its declared `reads` globs, making a network call with `net: false`, or seeing an environment variable outside its allow-list. `AWS_*`, `KUBECONFIG`, SOPS keys, or npm tokens visible to an extractor process is a critical.
- **File read or SSRF through parsing.** XML external entities, a `$ref` resolving outside the repository root or over the network, a symlink escaping the repository mount, a zip or decompression bomb.
- **Arbitrary query or code execution.** Anything that gets a query language, an expression evaluator, or a shell through the store interface, the MCP server, or a config file. The MCP server exposing a raw query tool is a critical by definition; it was removed deliberately.
- **Injection into agent context.** Third-party text reaching an MCP consumer without its `untrusted` tag or without delimiting. This is the highest-value attack against Seamline (threat T4, adversary AD1), and a working demonstration is very much wanted.
- **`seamline init` failing to gitignore the output directory**, or any path where a graph is written somewhere version control will pick it up.
- **Determinism or provenance integrity.** A way to make an `INFERRED` or `LLM_SUGGESTED` edge be treated as a fact, to write above an extractor's declared provenance ceiling, or to make a detector silently unable to fire.
- **UNAVAILABLE reported as clean.** A path where a failed extractor produces a negative finding rather than `UNKNOWN`. This one manufactures false confidence, which is the failure mode this project exists to prevent.
- **Supply chain of Seamline itself.** A dependency confusion vector, an unpinned or mutable action reference in a release workflow, a publish path that could ship an unattested artifact.

## What is out of scope

- **Vulnerabilities in the code Seamline analyses.** Seamline reports on your repository; a finding in your repository is your finding, not ours. If Seamline reports it _incorrectly_, that is a bug, and a normal issue is the right place.
- **The documented residual risks** in THREATMODEL.md section 7, when reported as-is. R1 (the redactor is heuristic), R2 (nothing controls what you do with an export), R4 (delimiting is not neutralisation), and R5 (the sandbox is process-level, not a VM) are known and stated. A concrete bypass that is materially worse than the documented limit is in scope; "heuristics can be evaded in principle" is not.
- **Missing hardening with no demonstrated impact.** A missing header, a permissive file mode with no reachable consequence, or a tool's default output flagged by a scanner. Show the impact.
- **Denial of service by an operator against their own local CLI.** Handing Seamline a hostile repository and crashing it is a robustness bug; file it as an issue. It becomes a security issue when a _third party_ controls the input, for example through a dependency's metadata, and the effect exceeds a crash.
- **Social engineering, physical access, or attacks on the maintainers' accounts** by means other than a flaw in this project.
- **Automated scanner output** submitted without a reproduction and an impact analysis.

---

## Security-relevant design decisions

These are deliberate and are unlikely to change. Knowing them saves you triage time.

- Seamline **makes no network calls**. No telemetry, no update check, no remote schema fetch. Network access from an extractor is off by default and enforced by the host, not requested by convention.
- Seamline **does not connect to your database**, read Terraform state, or read a Terraform plan. It reads static files. Plan files contain sensitive values, and a previous design revision claimed otherwise; it was wrong.
- **There is no query language** anywhere in the product. The store exposes a typed traversal API with depth bounded by construction, a result cap, and a statement timeout.
- **The output directory is gitignored on `init`** and every node carries a sensitivity level. Export is default-deny.
- **Third-party extractors are refused unless explicitly enabled**, and are unsigned by default.

If you think one of these has quietly stopped being true, that is exactly the kind of report we want.
