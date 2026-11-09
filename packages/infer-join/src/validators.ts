/**
 * Recognizing validators without a declaration.
 *
 * `VALIDATED_BY` is the edge that lets X3 (width/constraint disagreement) and
 * X7 (validator/database divergence) exist at all, and v2 expected a human to
 * write it by hand. Two rules recover it from extracted facts:
 *
 *   R1 decorator     A `CodeField` with a `DECORATED_WITH` edge to a symbol in
 *                    the class-validator family is validated by that symbol.
 *                    The structural edge is EXTRACTED; the only inference is
 *                    that the decorator's name denotes validation, which a
 *                    curated list makes a high-confidence call.
 *
 *   R2 correspondence A validator object (a Zod, Yup or Joi schema value such
 *                    as `PostSchema`) whose members correspond by name to a
 *                    target's fields validates those fields. This runs through
 *                    the same scorer as every other join, so it inherits the
 *                    container gate and the ambiguity policy. A validator is
 *                    a runtime value built through a validation library, never
 *                    a type declaration: an interface named `RowConstraints`
 *                    validates nothing, whatever its name suggests. Its members
 *                    are its own CodeFields when an extractor declares them,
 *                    otherwise the top-level properties of the schema a
 *                    contracts extractor lowered the same value to.
 *
 * Neither rule executes anything or resolves a type; both are name-and-
 * structure reads over what the extractors already produced.
 */

import type { GraphView, NodeId, NodeKind, SeamlineNode } from '@seamline/ontology';
import { canonicalTokens } from './naming.ts';
import { boolProp } from './facets.ts';

/**
 * Decorator names that assert a constraint on the field they decorate.
 * class-validator is the bulk of this; the pattern fallbacks below cover the
 * long tail (`@IsPositive`, `@MinLength`) without listing every one.
 */
export const VALIDATOR_DECORATORS: ReadonlySet<string> = new Set([
  'Allow', 'ArrayMaxSize', 'ArrayMinSize', 'ArrayNotEmpty', 'ArrayUnique',
  'Contains', 'Equals', 'Length', 'Matches', 'Max', 'MaxDate', 'MaxLength',
  'Min', 'MinDate', 'MinLength', 'NotContains', 'NotEquals', 'Validate',
  'ValidateBy', 'ValidateIf', 'ValidateNested', 'ValidatePromise',
]);

const VALIDATOR_DECORATOR_PATTERN = /^(Is[A-Z]|Not[A-Z]|Min|Max|Length|Matches|Validate|Assert|Check|Required|Optional)/u;

/**
 * Libraries whose objects are validation schemas. `extract-code-ts` keeps its
 * own copy of this list (it may not depend on this package) and sets a
 * Symbol's `library` prop only for these; an integration test holds the two
 * copies equal.
 */
export const VALIDATOR_LIBRARIES: ReadonlySet<string> = new Set([
  'ajv', 'class-validator', 'io-ts', 'joi', 'superstruct', 'typebox',
  'valibot', 'yup', 'zod', '@sinclair/typebox', 'runtypes',
]);

/**
 * `symbolKind` values (as `extract-code-ts` emits them) that denote a runtime
 * value. Types are erased at runtime, so an interface, type alias, class
 * declaration or enum is never itself the thing that validates.
 */
const VALIDATOR_SYMBOL_KINDS: ReadonlySet<string> = new Set(['function', 'variable']);

/** Suffixes stripped from a validator's name to find the subject it validates. */
const VALIDATOR_SUFFIXES: ReadonlySet<string> = new Set([
  'validator', 'validation', 'schema', 'rule', 'constraint', 'check', 'guard', 'shape',
]);

/** Is this decorator symbol asserting a constraint? */
export function isValidatorDecorator(name: string): boolean {
  if (VALIDATOR_DECORATORS.has(name)) return true;
  return VALIDATOR_DECORATOR_PATTERN.test(name);
}

/**
 * Is this symbol a validation schema?
 *
 * Two facts are both required. The symbol is a runtime value (`symbolKind`
 * `variable` or `function`), and an extractor says it is a validator: either
 * `validator: true`, or a `library` prop naming a validation library the
 * value is built through. A name is never enough on its own: `PostSchema`
 * built by `z.object(...)` qualifies, while `interface ColumnConstraints`
 * and a hand-rolled `const postSchema = {...}` do not.
 */
export function isValidatorSymbol(node: SeamlineNode): boolean {
  if (node.kind !== 'Symbol') return false;
  const symbolKind = node.props['symbolKind'];
  if (typeof symbolKind !== 'string' || !VALIDATOR_SYMBOL_KINDS.has(symbolKind)) return false;
  if (boolProp(node, 'validator') === true) return true;
  const library = node.props['library'];
  return typeof library === 'string' && VALIDATOR_LIBRARIES.has(library.toLowerCase());
}

/**
 * The domain thing a validator validates: its name with the validation suffix
 * and any `validate` prefix removed. Meaningful shape words remain:
 * `CreatePostSchema` gives `create_post`, not `post`.
 */
export function validatorSubject(name: string): string {
  let tokens = canonicalTokens(name);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && VALIDATOR_SUFFIXES.has(last)) tokens = tokens.slice(0, -1);
    else break;
  }
  while (tokens.length > 1) {
    const first = tokens[0];
    if (first === 'validate' || first === 'validation') tokens = tokens.slice(1);
    else break;
  }
  return tokens.join('_');
}

/** The member field names a validator symbol declares, via CONTAINS. */
export function validatorMembers(graph: GraphView, validatorId: NodeId): ReadonlyArray<SeamlineNode> {
  return containedOfKind(graph, validatorId, 'CodeField');
}

/**
 * Contracts a contracts extractor lowered from a schema value, keyed by the
 * file and name they were declared under and the dialect they were read as.
 * Build it once per inference run with `indexLoweredSchemas`.
 */
export type LoweredSchemaIndex = ReadonlyMap<string, SeamlineNode>;

function loweredSchemaKey(path: string, name: string, dialect: string): string {
  return JSON.stringify([path, name, dialect]);
}

export function indexLoweredSchemas(graph: GraphView): LoweredSchemaIndex {
  const index = new Map<string, SeamlineNode>();
  for (const contract of graph.nodesByKind('Contract')) {
    const dialect = contract.props['dialect'];
    if (contract.deletedAt !== null || contract.path === undefined || typeof dialect !== 'string') continue;
    index.set(loweredSchemaKey(contract.path, contract.name, dialect.toLowerCase()), contract);
  }
  return index;
}

/** `/properties/nullable`, not `/properties/address/properties/city`. */
const TOP_LEVEL_PROPERTY_POINTER = /^\/properties\/[^/]+$/u;

/**
 * The members of a schema value, read from the schema it was lowered to.
 *
 * A schema value such as `export const RowSchema = z.object({ ... })` has no
 * member CodeFields: its members are call arguments, not declarations. A
 * contracts extractor that reads the same value emits it as a `Contract` named
 * after the value, in the same file, whose `dialect` is the library the value
 * is built through, with a `SchemaProperty` per property. That (file, name,
 * dialect) agreement is the link; the members are the Contract's top-level
 * properties declared in that file. Nested properties belong to a nested
 * object, not to this value.
 */
export function loweredSchemaMembers(
  graph: GraphView,
  lowered: LoweredSchemaIndex,
  validator: SeamlineNode,
): ReadonlyArray<SeamlineNode> {
  const library = validator.props['library'];
  if (validator.path === undefined || typeof library !== 'string') return [];
  const contract = lowered.get(loweredSchemaKey(validator.path, validator.name, library.toLowerCase()));
  if (contract === undefined) return [];
  return containedOfKind(graph, contract.id, 'SchemaProperty').filter((property) => {
    const pointer = property.props['jsonPointer'];
    if (property.path !== validator.path || typeof pointer !== 'string') return false;
    return TOP_LEVEL_PROPERTY_POINTER.test(pointer);
  });
}

function containedOfKind(graph: GraphView, owner: NodeId, kind: NodeKind): ReadonlyArray<SeamlineNode> {
  return graph.edgesFrom(owner, 'CONTAINS')
    .filter((e) => e.deletedAt === null)
    .map((e) => graph.node(e.dst))
    .filter((n): n is SeamlineNode => n !== undefined && n.kind === kind && n.deletedAt === null)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
