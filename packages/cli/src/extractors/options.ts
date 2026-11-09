/**
 * Narrowing helpers for an extractor's option bag, which arrives verbatim from
 * the config file (`seamline.config.json`) and so is `unknown` field by field.
 */

export type OptionBag = Readonly<Record<string, unknown>>;

export function stringOpt(opts: OptionBag, key: string): string | undefined {
  const v = opts[key];
  return typeof v === 'string' ? v : undefined;
}

export function numberOpt(opts: OptionBag, key: string): number | undefined {
  const v = opts[key];
  return typeof v === 'number' ? v : undefined;
}

export function boolOpt(opts: OptionBag, key: string): boolean | undefined {
  const v = opts[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function stringArrayOpt(opts: OptionBag, key: string): readonly string[] | undefined {
  const v = opts[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as readonly string[])
    : undefined;
}
