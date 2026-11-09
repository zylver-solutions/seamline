# First dependency effect certificate

Status: implementation under review (design: [library effect certificates](../design/library-effect-certificates.md)). This is a dependency of the required Cypress artifact, not a replacement development target. It supplies no Cypress initialization proof, X7 firing, independent labels or qualification.

The existing DEV lock resolves `ansi-regex@5.0.1` with full integrity `sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==`. Separately read [published metadata](https://registry.npmjs.org/ansi-regex/5.0.1) and the [published artifact](https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz) agree. The artifact is 2768 bytes, SHA256 `0e0eadcdaada805db5d85b53ad5cdca0760b996ee199ec9658e7b34aa6c8e0d9`. Its manifest and included license declare MIT. No package is installed, executed, copied into this repository or added as an engine dependency.

| Published member | SHA256 |
| --- | --- |
| package.json | `8b2dc166f2b74d5098bad38bdd3dd2f4d4775c626199872f5e36dbb48c40931d` |
| index.js | `c92312790eb1f246b7c4c1fe9c1247b15441bbca3c6cb64d167beefc45302753` |
| license | `48da2f39e100d4085767e94966b43f4fa95ff6a0698fba57ed460914e35f94a0` |

## Initialization and calls

The manifest has no runtime, optional or peer dependency, conditional exports, alternate module/browser entry or module-type override. Node's ordinary CommonJS default entry is index.js. Ordinary ESM interop loads the same CommonJS entry; a transpilation between these two modes selects no different implementation. Custom origins, loaders, resolver maps, hooks and compiler substitutions receive no permission.

The complete initializer is strict-mode setup followed by assignment of a newly created function to its own CommonJS module export. Creating that function evaluates no body/default-parameter expression. There is no import, require, top-level call, getter, callback, native operation, shared intrinsic write or source emission. Its package/context closure is therefore one artifact with no dependency edge. The published bytes, member hashes and complete lock snapshot must match; an unexpected dependency or context cannot reuse this proof.

Only direct zero-argument calls receive API credit. Such a call uses its own default literal object and false option, constructs an array of artifact-owned literal strings, joins those strings and creates a fresh RegExp from the fixed pattern and flag. No application argument, getter, proxy, callback or arbitrary regular expression is supplied. Under the complete source world's existing intrinsic/library/cache protections, these operations cannot alter the request validator, parse result, client lineage/cache or framework invocation. The new RegExp is ordinary isolated data; extracting constructors/prototypes or using reflection remains outside the existing source guard.

Any factory argument, callable alias/mutation/escape, runtime re-export, unsupported load or unresolved entry/use receives UNKNOWN. Initialization-only import success cannot grant an arbitrary API. Complete binding, unchanged forwarding, model identity, authority and currentness remain required after import admission. Inspection and analysis never construct or run this package's regular expression.

The certificate and graph checks follow [the accepted design](../design/library-effect-certificates.md). All additional caps and existing syntax/cache replay charges apply. The unchanged real parent/fix, independent-account, calibration, sealed precision/Wilson and per-detector recall requirements remain unmet until measured directly; a passing leaf fixture does not qualify the root application.
