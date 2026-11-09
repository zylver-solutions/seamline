// SPDX-License-Identifier: Apache-2.0
/** Read declared generator/model lineage, never generated or installed client code. */
import { dirname } from 'node:path';
import { WriteSource, WriteUnknown } from './write-source.ts';

interface Token { readonly kind: 'word' | 'string' | 'punct' | 'newline'; readonly text: string }

function tokens(text: string): Token[] {
  const out: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === '\n') { out.push({ kind: 'newline', text: '\n' }); index++; }
    else if (/\s/.test(character)) index++;
    else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index + 2);
      index = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new WriteUnknown('WRITE_PRISMA_PARSE');
      for (const newline of text.slice(index, end + 2).matchAll(/\n/g)) {
        void newline;
        out.push({ kind: 'newline', text: '\n' });
      }
      index = end + 2;
    } else if (character === '"') {
      const start = index++;
      let closed = false;
      while (index < text.length) {
        const next = text[index++];
        if (next === '\\') index++;
        else if (next === '"') { closed = true; break; }
        else if (next === '\n') throw new WriteUnknown('WRITE_PRISMA_PARSE');
      }
      if (!closed) throw new WriteUnknown('WRITE_PRISMA_PARSE');
      try { out.push({ kind: 'string', text: JSON.parse(text.slice(start, index)) as string }); }
      catch { throw new WriteUnknown('WRITE_PRISMA_PARSE'); }
    } else if (/[A-Za-z_\d]/.test(character)) {
      const start = index++;
      while (index < text.length && /[A-Za-z_\d]/.test(text[index] as string)) index++;
      out.push({ kind: 'word', text: text.slice(start, index) });
    } else {
      out.push({ kind: 'punct', text: character });
      index++;
    }
    if (out.length > 10_000) throw new WriteUnknown('WRITE_PRISMA_SYNTAX_CAP');
  }
  return out;
}

interface Block { readonly kind: string; readonly name: string; readonly body: readonly Token[] }

function blocks(input: readonly Token[]): Block[] {
  const out: Block[] = [];
  let index = 0;
  while (index < input.length) {
    if (input[index]?.kind === 'newline') { index++; continue; }
    const kind = input[index++];
    const name = input[index++];
    if (kind?.kind !== 'word' || name?.kind !== 'word' || input[index++]?.text !== '{')
      throw new WriteUnknown('WRITE_PRISMA_PARSE');
    const start = index;
    let depth = 1;
    while (index < input.length && depth > 0) {
      const token = input[index++];
      if (token?.kind !== 'punct') continue;
      if (token.text === '{') depth++;
      else if (token.text === '}') depth--;
    }
    if (depth !== 0) throw new WriteUnknown('WRITE_PRISMA_PARSE');
    out.push({ kind: kind.text, name: name.text, body: input.slice(start, index - 1) });
  }
  return out;
}

function lines(body: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let line: Token[] = [];
  let depth = 0;
  for (const token of body) {
    if (token.kind === 'punct') {
      if (token.text === '(' || token.text === '[') depth++;
      else if (token.text === ')' || token.text === ']') depth--;
      if (depth < 0) throw new WriteUnknown('WRITE_PRISMA_PARSE');
    }
    if (token.kind === 'newline') {
      if (depth === 0 && line.length > 0) { out.push(line); line = []; }
    } else line.push(token);
  }
  if (depth !== 0) throw new WriteUnknown('WRITE_PRISMA_PARSE');
  if (line.length > 0) out.push(line);
  return out;
}

function stringAttribute(line: readonly Token[], attribute: string, doubled: boolean): string | undefined {
  const hits: string[] = [];
  for (let index = 0; index < line.length; index++) {
    if (line[index]?.text !== '@' || line[index]?.kind !== 'punct') continue;
    if (doubled) {
      if (line[index + 1]?.text !== '@') continue;
    } else if (line[index - 1]?.text === '@' || line[index + 1]?.text === '@') continue;
    const at = index + (doubled ? 2 : 1);
    if (line[at]?.text !== attribute) continue;
    if (line[at + 1]?.text !== '(' || line[at + 2]?.kind !== 'string' || line[at + 3]?.text !== ')')
      throw new WriteUnknown('WRITE_PRISMA_MAPPING_UNKNOWN');
    hits.push((line[at + 2] as Token).text);
  }
  if (hits.length > 1 || hits[0] === '') throw new WriteUnknown('WRITE_PRISMA_MAPPING_UNKNOWN');
  return hits[0];
}

export interface WriteModel {
  readonly model: string;
  readonly table: string;
  readonly schema: string;
  readonly fields: ReadonlyMap<string, string>;
  readonly generatedDirectory: string;
  readonly syntaxCost: number;
  readonly file: string;
}

export function prismaWriteModels(project: WriteSource): readonly WriteModel[] {
  const out: WriteModel[] = [];
  let syntaxCost = 0;
  for (const file of project.inventory.filter(path => path.toLowerCase().endsWith('.prisma'))) {
    const input = tokens(project.text(file));
    syntaxCost += input.length;
    if (syntaxCost > 10_000) throw new WriteUnknown('WRITE_SYNTAX_CAP');
    const declarations = blocks(input);
    const generators = declarations.filter(block => block.kind === 'generator');
    const datasources = declarations.filter(block => block.kind === 'datasource');
    if (generators.length !== 1 || datasources.length !== 1) throw new WriteUnknown('WRITE_PRISMA_GENERATOR_UNKNOWN');
    const options = new Map<string, string>();
    for (const line of lines((generators[0] as Block).body)) {
      if (line.length !== 3 || line[0]?.kind !== 'word' || line[1]?.text !== '=' || line[2]?.kind !== 'string' ||
          !['provider', 'output', 'engineType'].includes(line[0].text) || options.has(line[0].text))
        throw new WriteUnknown('WRITE_PRISMA_GENERATOR_UNKNOWN');
      options.set(line[0].text, line[2].text);
    }
    if (options.get('provider') !== 'prisma-client' || options.get('engineType') !== 'client' ||
        options.get('output') === undefined) throw new WriteUnknown('WRITE_PRISMA_GENERATOR_UNKNOWN');
    const providerLines = lines((datasources[0] as Block).body).filter(line => line[0]?.text === 'provider');
    if (providerLines.length !== 1 || providerLines[0]?.length !== 3 ||
        providerLines[0][1]?.text !== '=' || providerLines[0][2]?.kind !== 'string' ||
        providerLines[0][2]?.text !== 'postgresql') throw new WriteUnknown('WRITE_PRISMA_DATASOURCE_UNKNOWN');
    const generatedDirectory = project.path(dirname(project.path(project.root, file)), options.get('output') as string);
    for (const model of declarations.filter(block => block.kind === 'model')) {
      const fields = new Map<string, string>();
      let table = model.name;
      let schema = 'public';
      let mapped = false;
      let schemaMapped = false;
      for (const line of lines(model.body)) {
        if (line[0]?.text === '@' && line[1]?.text === '@') {
          if (line[2]?.text === 'ignore') throw new WriteUnknown('WRITE_PRISMA_MODEL_IGNORED');
          const mapping = stringAttribute(line, 'map', true);
          const namespace = stringAttribute(line, 'schema', true);
          if (mapping !== undefined) {
            if (mapped) throw new WriteUnknown('WRITE_PRISMA_MAPPING_UNKNOWN');
            table = mapping; mapped = true;
          }
          if (namespace !== undefined) {
            if (schemaMapped) throw new WriteUnknown('WRITE_PRISMA_MAPPING_UNKNOWN');
            schema = namespace; schemaMapped = true;
          }
          continue;
        }
        if (line[0]?.kind !== 'word' || line[1]?.kind !== 'word') throw new WriteUnknown('WRITE_PRISMA_FIELD_UNKNOWN');
        if (line[1].text !== 'String' || line[2]?.text === '[') continue;
        const mapping = stringAttribute(line, 'map', false) ?? line[0].text;
        if (line.some((token, index) => token.text === '@' && line[index + 1]?.text === 'ignore')) continue;
        if (fields.has(line[0].text)) throw new WriteUnknown('WRITE_PRISMA_FIELD_AMBIGUOUS');
        fields.set(line[0].text, mapping);
      }
      if (out.some(other => other.generatedDirectory === generatedDirectory && other.model === model.name))
        throw new WriteUnknown('WRITE_PRISMA_MODEL_AMBIGUOUS');
      if (new Set(fields.values()).size !== fields.size) throw new WriteUnknown('WRITE_PRISMA_FIELD_AMBIGUOUS');
      out.push({ model: model.name, table, schema, fields, generatedDirectory, file, syntaxCost: 0 });
    }
  }
  project.chargeSyntax('prisma-model-metadata', syntaxCost);
  return out.map(model => ({ ...model, syntaxCost }));
}
