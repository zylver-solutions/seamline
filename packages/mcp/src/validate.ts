/**
 * Typed parameter validation, and the JSON Schema derived from it.
 *
 * One declaration produces both the `inputSchema` advertised in `tools/list`
 * and the runtime check, so the schema an agent is shown and the schema the
 * server enforces cannot drift apart. There is no validation library here for
 * the reason v3 §2.7 and §10 give: every runtime dependency is supply-chain
 * surface this project has committed to minimizing.
 *
 * Validation is allow-list shaped (rule: allowlists over denylists) — an
 * unrecognised property is an error, not something quietly ignored, because a
 * silently-dropped parameter is how a caller ends up believing a filter was
 * applied.
 */

export type ParamSpec =
  | {
      readonly kind: 'string';
      readonly required: boolean;
      readonly description: string;
      readonly maxLength: number;
      readonly pattern?: string;
      readonly choices?: readonly string[];
    }
  | {
      readonly kind: 'integer';
      readonly required: boolean;
      readonly description: string;
      readonly min: number;
      readonly max: number;
      readonly fallback?: number;
    }
  | {
      readonly kind: 'boolean';
      readonly required: boolean;
      readonly description: string;
      readonly fallback?: boolean;
    }
  | {
      readonly kind: 'stringArray';
      readonly required: boolean;
      readonly description: string;
      readonly maxItems: number;
      readonly maxLength: number;
      readonly choices?: readonly string[];
    };

export type ParamSchema = Readonly<Record<string, ParamSpec>>;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export function validateParams<T extends Record<string, unknown>>(
  schema: ParamSchema,
  input: unknown,
): ValidationResult<T> {
  const errors: string[] = [];
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    return { ok: false, errors: ['arguments must be a JSON object'] };
  }
  const raw = (input ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      errors.push(`unknown parameter \`${key}\`; allowed: ${Object.keys(schema).sort().join(', ')}`);
    }
  }

  const value: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const provided = raw[name];
    if (provided === undefined || provided === null) {
      if (spec.required) {
        errors.push(`missing required parameter \`${name}\` (${spec.kind})`);
      } else if (spec.kind === 'integer' && spec.fallback !== undefined) {
        value[name] = spec.fallback;
      } else if (spec.kind === 'boolean' && spec.fallback !== undefined) {
        value[name] = spec.fallback;
      }
      continue;
    }
    const checked = checkOne(name, spec, provided, errors);
    if (checked !== undefined) value[name] = checked;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as T };
}

function checkOne(name: string, spec: ParamSpec, v: unknown, errors: string[]): unknown {
  switch (spec.kind) {
    case 'string': {
      if (typeof v !== 'string') {
        errors.push(`\`${name}\` must be a string, got ${typeName(v)}`);
        return undefined;
      }
      if (v.length === 0) {
        errors.push(`\`${name}\` must not be empty`);
        return undefined;
      }
      if (v.length > spec.maxLength) {
        errors.push(`\`${name}\` exceeds the ${spec.maxLength}-character limit (got ${v.length})`);
        return undefined;
      }
      if (spec.choices !== undefined && !spec.choices.includes(v)) {
        errors.push(`\`${name}\` must be one of: ${spec.choices.join(', ')}`);
        return undefined;
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern, 'u').test(v)) {
        errors.push(`\`${name}\` does not match the required format`);
        return undefined;
      }
      return v;
    }
    case 'integer': {
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        errors.push(`\`${name}\` must be an integer, got ${typeName(v)}`);
        return undefined;
      }
      if (v < spec.min || v > spec.max) {
        errors.push(`\`${name}\` must be between ${spec.min} and ${spec.max} (got ${v})`);
        return undefined;
      }
      return v;
    }
    case 'boolean': {
      if (typeof v !== 'boolean') {
        errors.push(`\`${name}\` must be a boolean, got ${typeName(v)}`);
        return undefined;
      }
      return v;
    }
    case 'stringArray': {
      if (!Array.isArray(v)) {
        errors.push(`\`${name}\` must be an array of strings, got ${typeName(v)}`);
        return undefined;
      }
      if (v.length === 0) {
        errors.push(`\`${name}\` must not be empty`);
        return undefined;
      }
      if (v.length > spec.maxItems) {
        errors.push(`\`${name}\` accepts at most ${spec.maxItems} items (got ${v.length})`);
        return undefined;
      }
      const out: string[] = [];
      for (const [i, item] of v.entries()) {
        if (typeof item !== 'string' || item.length === 0) {
          errors.push(`\`${name}[${i}]\` must be a non-empty string`);
          return undefined;
        }
        if (item.length > spec.maxLength) {
          errors.push(`\`${name}[${i}]\` exceeds the ${spec.maxLength}-character limit`);
          return undefined;
        }
        if (spec.choices !== undefined && !spec.choices.includes(item)) {
          errors.push(`\`${name}[${i}]\` must be one of: ${spec.choices.join(', ')}`);
          return undefined;
        }
        out.push(item);
      }
      return out;
    }
    default:
      return undefined;
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** JSON Schema for `tools/list`. Derived, never hand-written. */
export function toJsonSchema(schema: ParamSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.required) required.push(name);
    properties[name] = propertySchema(spec);
  }
  return {
    type: 'object',
    properties,
    required: required.sort(),
    additionalProperties: false,
  };
}

function propertySchema(spec: ParamSpec): Record<string, unknown> {
  switch (spec.kind) {
    case 'string': {
      const out: Record<string, unknown> = {
        type: 'string',
        description: spec.description,
        minLength: 1,
        maxLength: spec.maxLength,
      };
      if (spec.choices !== undefined) out['enum'] = [...spec.choices];
      if (spec.pattern !== undefined) out['pattern'] = spec.pattern;
      return out;
    }
    case 'integer': {
      const out: Record<string, unknown> = {
        type: 'integer',
        description: spec.description,
        minimum: spec.min,
        maximum: spec.max,
      };
      if (spec.fallback !== undefined) out['default'] = spec.fallback;
      return out;
    }
    case 'boolean': {
      const out: Record<string, unknown> = { type: 'boolean', description: spec.description };
      if (spec.fallback !== undefined) out['default'] = spec.fallback;
      return out;
    }
    case 'stringArray': {
      const items: Record<string, unknown> = { type: 'string', minLength: 1, maxLength: spec.maxLength };
      if (spec.choices !== undefined) items['enum'] = [...spec.choices];
      return {
        type: 'array',
        description: spec.description,
        items,
        minItems: 1,
        maxItems: spec.maxItems,
      };
    }
    default:
      return { type: 'null' };
  }
}
