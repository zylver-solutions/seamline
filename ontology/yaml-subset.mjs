// SPDX-License-Identifier: Apache-2.0
//
// ontology/yaml-subset.mjs: the minimal YAML reader shared by `ontology/lint.mjs`
// and `scripts/gen-ontology-ref.mjs`. Zero dependencies. It reads the subset
// `ontology/seamline.yaml` is written in and fails loudly outside it.
// ---------------------------------------------------------------------------
// Minimal YAML reader.
//
// Deliberately narrow: block mappings, block sequences, inline flow mappings
// (`{ a: b }`), inline flow sequences (`[A, B]`), quoted and plain scalars, and
// comments. No anchors, no block scalars, no multi-document streams. If
// seamline.yaml grows past this subset, the lint fails loudly rather than
// silently misreading, which is the behaviour you want from a gate.
// ---------------------------------------------------------------------------

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/** Split `key: value` at the first structural colon, or return null. */
function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') return null; // a flow collection, not a mapping key
    if (c === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return [unquote(text.slice(0, i)), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseScalarOrFlow(raw) {
  const t = raw.trim();
  if (t === '') return null;
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    return inner === '' ? [] : splitTopLevel(inner, ',').map((x) => parseScalarOrFlow(x));
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim();
    const obj = {};
    if (inner === '') return obj;
    for (const part of splitTopLevel(inner, ',')) {
      const kv = splitKey(part.trim());
      if (!kv) throw new Error(`unsupported flow mapping entry: ${part}`);
      obj[kv[0]] = parseScalarOrFlow(kv[1]);
    }
    return obj;
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (t.includes('|') || t.includes('>')) {
    if (/^[|>][-+]?\d*$/.test(t))
      throw new Error('block scalars are outside the supported YAML subset');
  }
  return unquote(t);
}

export function parseYaml(text) {
  const lines = [];
  text.split('\n').forEach((raw, idx) => {
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') return;
    lines.push({
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
      no: idx + 1,
    });
  });

  let pos = 0;

  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    if (lines[pos].text.startsWith('- ') || lines[pos].text === '-') return parseSeq(indent);
    return parseMap(indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      if (line.text.startsWith('- ')) break;
      const kv = splitKey(line.text);
      if (!kv) throw new Error(`line ${line.no}: expected 'key: value', got: ${line.text}`);
      const [key, rest] = kv;
      pos++;
      if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent)
          obj[key] = parseBlock(lines[pos].indent);
        else obj[key] = null;
      } else {
        obj[key] = parseScalarOrFlow(rest);
      }
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      const line = lines[pos];
      const rest = line.text.slice(2).trim();
      const kv = splitKey(rest);
      if (kv) {
        // `- key: value` opens a mapping whose members are indented further.
        const itemIndent = indent + 2;
        lines[pos] = { indent: itemIndent, text: rest, no: line.no };
        arr.push(parseMap(itemIndent));
      } else {
        pos++;
        arr.push(parseScalarOrFlow(rest));
      }
    }
    return arr;
  }

  const root = parseBlock(lines.length ? lines[0].indent : 0);
  if (pos !== lines.length) {
    throw new Error(
      `line ${lines[pos].no}: unconsumed input (indentation outside the supported subset): ${lines[pos].text}`,
    );
  }
  return root;
}
