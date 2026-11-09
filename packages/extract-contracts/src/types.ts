/**
 * Local vocabulary for the API-contract extractor.
 *
 * Nothing here widens `@seamline/ontology`; these are the extractor's own
 * intermediate shapes plus the two enumerations (`TypeCategory`, `AuthMode`)
 * that this extractor publishes as part of its node props so that
 * `infer-join` and the X1/X2/X3/X6/X7 detectors can compare across domains.
 */

/**
 * The cross-domain type category. This is the join vocabulary: a
 * `SchemaProperty` and a `Column` are only comparable once both have been
 * reduced to one of these.
 *
 * `unknown` is deliberately a member. A category we could not determine must
 * be reported as undetermined rather than guessed into `text`, because a wrong
 * category manufactures an X2 finding out of nothing.
 */
export const TYPE_CATEGORIES = [
  'integer',
  'text',
  'boolean',
  'timestamp',
  'numeric',
  'json',
  'uuid',
  'enum',
  'unknown',
] as const;
export type TypeCategory = (typeof TYPE_CATEGORIES)[number];

/**
 * Declared auth for an `Operation`. Feeds X6, the only `critical` detector, so
 * the three negative-ish states are kept apart on purpose:
 *
 * - `none`     the document says, explicitly, that no auth applies
 *              (`security: []`, or a requirement list of exactly `[{}]`).
 * - `optional` the requirement list contains `{}` alongside real schemes, so
 *              an anonymous caller is admitted.
 * - `required` a non-empty requirement list with no anonymous alternative.
 * - `unknown`  neither the operation nor the document declared `security`.
 *              This is NOT the same as `none`; X6 must not fire on it.
 */
export const AUTH_MODES = ['required', 'optional', 'none', 'unknown'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Where the effective security requirement was read from. */
export const AUTH_SOURCES = ['operation', 'document', 'absent'] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

export interface DeclaredAuth {
  readonly mode: AuthMode;
  readonly source: AuthSource;
  /** Sorted, de-duplicated security scheme names. Empty for `none`/`unknown`. */
  readonly schemes: readonly string[];
  /** Sorted `scheme:scope` pairs. Empty when no scopes are declared. */
  readonly scopes: readonly string[];
}

/**
 * A normalized property fact, independent of which of the three source
 * dialects produced it.
 *
 * `required` and `nullable` are two independent axes and are never derived
 * from one another:
 *
 * - `required`  presence obligation. Read only from the parent object's
 *               `required` array (JSON Schema / OpenAPI), a parameter's own
 *               `required` field, or the absence of `.optional()` in Zod.
 * - `nullable`  the value may be null. Read from `nullable: true` (OAS 3.0),
 *               `"null"` inside a `type` array (JSON Schema / OAS 3.1), a
 *               `null` branch of `anyOf`/`oneOf`, or `.nullable()` in Zod.
 *               An actual literal `{}` in the admitted default OAS 3.1
 *               context also permits null; an opaque context withholds that
 *               facet. This does not change recursive schema analysis.
 *
 * Conflating them is what produces false X1s.
 *
 * `typeCategory`, `required`, `nullable`, `isArray` and `hasDefault` are
 * `null` when the source declares the property but a construct this extractor
 * does not model hides that facet (an unrecognised Zod modifier, say). `null`
 * means NOT EXTRACTED: it is never a declared `false`, and `schemaPropertyNode`
 * leaves the prop off the node entirely so no consumer can read it as a value.
 */
export interface PropertyFact {
  /** Derived only by the admitted request-to-write source proof. */
  readonly direction?: 'request';
  readonly lengthUpperState?: 'bounded' | 'unbounded' | 'unknown';
  readonly valueRole?: 'validated-write-input';
  readonly writeBindingComplete?: boolean;
  readonly successfulParse?: boolean;
  readonly unchangedForwarding?: boolean;
  readonly modelBindingComplete?: boolean;
  readonly storageModel?: string;
  readonly storageField?: string;
  readonly storageTable?: string;
  readonly container?: string;
  readonly bindingWitness?: string;
  readonly contract: string;
  readonly jsonPointer: string;
  readonly name: string;
  /** Raw declared type, verbatim from the document (`string`, `integer`, ...). */
  readonly type: string;
  readonly format: string | null;
  readonly typeCategory: TypeCategory | null;
  readonly required: boolean | null;
  readonly nullable: boolean | null;
  readonly isArray: boolean | null;
  readonly hasDefault: boolean | null;
  readonly defaultValue: string | number | boolean | null;
  readonly readOnly: boolean;
  readonly writeOnly: boolean;
  readonly deprecated: boolean;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly pattern: string | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly exclusiveMinimum: number | null;
  readonly exclusiveMaximum: number | null;
  readonly multipleOf: number | null;
  readonly minItems: number | null;
  readonly maxItems: number | null;
  /** Canonical JSON of the enum members, sorted. `null` when not an enum. */
  readonly enumValues: string | null;
  readonly enumCount: number | null;
  /** `path` | `query` | `header` | `cookie` for OpenAPI parameters, else null. */
  readonly in: string | null;
  readonly description: string | null;
  /** Repo-relative POSIX path of the file this fact was read from. */
  readonly file: string;
}

export interface OperationFact {
  readonly contract: string;
  readonly method: string;
  readonly path: string;
  readonly operationId: string | null;
  readonly summary: string | null;
  readonly deprecated: boolean;
  readonly auth: DeclaredAuth;
  /** Declared handler binding, path-free, or null when the document declares none. */
  readonly handler: string | null;
  readonly file: string;
  readonly jsonPointer: string;
}

export interface ContractFact {
  readonly name: string;
  /** `openapi` | `json-schema` | `zod` */
  readonly dialect: ContractDialect;
  readonly version: string | null;
  readonly title: string | null;
  readonly file: string;
}

export const CONTRACT_DIALECTS = ['openapi', 'json-schema', 'zod'] as const;
export type ContractDialect = (typeof CONTRACT_DIALECTS)[number];

/** Everything one source document contributed. */
export interface DocumentFacts {
  readonly contracts: readonly ContractFact[];
  readonly operations: readonly OperationFact[];
  readonly properties: readonly PropertyFact[];
  readonly diagnostics: readonly string[];
  /** True when the document could not be processed at all. */
  readonly failed: boolean;
  /**
   * True when the document may declare contracts this run could not read to a
   * complete property set. The run does not vouch for the file: it must not be
   * able to bury what an earlier run read from it. Zod only; absent otherwise.
   */
  readonly unvouched?: boolean;
  /** Contract names the document declares whose shape could not be read. */
  readonly withheld?: readonly string[];
}

export const EMPTY_FACTS: DocumentFacts = {
  contracts: [],
  operations: [],
  properties: [],
  diagnostics: [],
  failed: false,
};

export interface ExtractLimits {
  /** Maximum bytes for a single source file. */
  readonly maxFileBytes: number;
  /** Maximum `$ref` hops on one resolution chain. */
  readonly maxRefDepth: number;
  /** Maximum nesting depth when walking a schema. */
  readonly maxSchemaDepth: number;
  /** Maximum documents loaded through `$ref` from one root document. */
  readonly maxRefDocuments: number;
  /** Maximum files visited by discovery. */
  readonly maxFiles: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxRefDepth: 32,
  maxSchemaDepth: 64,
  maxRefDocuments: 64,
  maxFiles: 20_000,
};

export interface ExtractOptions {
  /** Current extract-data output, passed as canonical JSON by the host. */
  readonly dataModelIndex?: string;
  /** Absolute path to the repository root. Every read is confined to it. */
  readonly repoRoot: string;
  /** Repo name used as the first id component. Must not contain ':'. */
  readonly repo: string;
  readonly runId: string;
  /**
   * Explicit repo-relative POSIX paths to consider. When omitted the extractor
   * discovers candidates under `repoRoot`.
   */
  readonly files?: readonly string[];
  readonly limits?: Partial<ExtractLimits>;
}
