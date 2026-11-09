// SPDX-License-Identifier: Apache-2.0
/** Unknown script execution cannot manufacture complete fields or authority. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { WriteSource } from './write-source.ts';
import { DEFAULT_LIMITS } from './types.ts';
import { permitsQueryDataCopy } from './write-query-copy-proof.ts';
import { isCanonicalSelectorText } from '@seamline/core';
import { extractContracts } from './extract.ts';
import { makeWriteFixture, WRITE_FILES, writeFixtureIndex } from './write-test-support.ts';

const integrity='sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==';
const manifest={name:'@sample/forms',dependencies:{next:'16.2.6',zod:'4.3.6','ansi-regex':'5.0.1'}};
const lock=(WRITE_FILES['pnpm-lock.yaml']as string).replace('    dependencies:\n',
  '    dependencies:\n      ansi-regex: {specifier: 5.0.1, version: 5.0.1}\n')+
  `  ansi-regex@5.0.1:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  ansi-regex@5.0.1: {}\n`;
function run(extra:Record<string,string>={}) {
  const fixture=makeWriteFixture({'package.json':JSON.stringify(manifest),'pnpm-lock.yaml':lock,
    'src/ansi.ts':"import make from 'ansi-regex'; export const pattern = make().source;",...extra});
  try{return extractContracts({repoRoot:fixture.root,repo:'script-origin',runId:'run-origin',dataModelIndex:writeFixtureIndex('script-origin')});}
  finally{fixture.dispose();}
}
function complete(extra:Record<string,string>={}) {
  const output=run(extra);
  assert.equal(output.result.status,'PASS',output.result.diagnostics.join('\n'));
  const properties=output.nodes.filter(n=>n.kind==='SchemaProperty'&&['title','caption'].includes(n.name));
  assert.deepEqual(properties.map(n=>n.name).sort(),['caption','title']);
  assert.ok(properties.every(n=>n.provenance==='EXTRACTED'&&n.props['writeBindingComplete']===true&&n.props['storageModel']==='Entry'));
  assert.ok(output.result.authoritative.some(c=>isCanonicalSelectorText(c.selector??'')));
  return properties.map(n=>n.id).sort();
}
function unknown(extra:Record<string,string>) {
  const output=run(extra);
  assert.deepEqual(output.nodes.filter(n=>n.kind==='Contract'||n.kind==='SchemaProperty'),[]);
  assert.equal(output.result.authoritative.some(c=>isCanonicalSelectorText(c.selector??'')),false);
  assert.ok(output.result.diagnostics.some(d=>d.includes('WRITE_')));
}

test('scriptless real-artifact control still proves complete binding',()=>{complete();});
test('empty root and nested script maps preserve complete facts and identity',()=>{
  assert.deepEqual(complete({'package.json':JSON.stringify({...manifest,scripts:{}}),
    'tools/package.json':'{"name":"sample-tools","scripts":{}}'}),complete());
});
for(const [name,scripts]of[
  ['unknown emitter',{build:'custom-emitter'}],
  ['quoted loader flag',{start:'node --lo""ader loader-package server.js'}],
  ['quoted preload flag',{start:'node --re""quire hook-package server.js'}],
  ['quoted compiler patcher',{build:'t""spc'}],
  ['expanded command',{build:'$COMPILER'}],
  ['shell alias or function',{build:'compile() { custom-emitter; }; compile'}],
  ['unproved literal compiler',{build:'tsc'}],
  ['unproved literal framework',{build:'next build --turbo'}],
  ['non-string script value',{build:true}],
  ['malformed script map',[]],
]as const)test(`script origin withholds ${name}`,()=>unknown({'package.json':JSON.stringify({...manifest,scripts})}));
test('a nested package can also declare an unproved source writer',()=>{
  unknown({'tools/package.json':'{"name":"sample-tools","scripts":{"build":"custom-emitter"}}'});
});
test('IDE descriptor plus pinned providers still does not prove an executing compiler',()=>{
  unknown({'tsconfig.json':'{"compilerOptions":{"plugins":[{"name":"next"}]}}'});
});

const getRoute = `import {z} from 'zod'; import {decode} from '../../parser';
export async function GET(request: Request) {
 const schema = z.object({title:z.string().optional(),caption:z.string().optional()});
 return await decode(request,schema);
}`;
for(const [name,source]of[
  ['ordinary legacy-library binding',WRITE_FILES['src/parser.ts']as string],
  ['closed query-copy legacy-library binding',(WRITE_FILES['src/parser.ts']as string)
    .replace('let query = {};','let query = Object.fromEntries(new URL(input.url).searchParams);')
    .replace('else if (queryMethod) { query = parsed.data; }',String.raw`else if (queryMethod) {
      query = parsed.data;
      for (const entryKey of Object.keys(originalQuery)) {
        if (/\d+$/.test(entryKey) && !(entryKey in query)) { query[entryKey] = originalQuery[entryKey]; }
      }
    }`)],
]as const){
  test(`scriptless ${name} remains complete without an additional library certificate`,()=>{
    complete({'src/ansi.ts':'','src/parser.ts':source,
      ...(name.startsWith('closed')?{'src/app/read/route.ts':getRoute}:{})});
  });
  test(`unproved commands withhold ${name} without an additional library certificate`,()=>{
    unknown({'src/ansi.ts':'','src/parser.ts':source,
      ...(name.startsWith('closed')?{'src/app/read/route.ts':getRoute}:{}),
      'package.json':JSON.stringify({...manifest,scripts:{build:'custom-emitter'}})});
  });
}

for(const scripts of [undefined,{build:'custom-emitter'}])
  test(`query-copy certificate itself ${scripts===undefined?'admits scriptless source':'refuses unknown commands'}`,()=>{
    const parser=(WRITE_FILES['src/parser.ts']as string)
      .replace('let query = {};','let query = Object.fromEntries(new URL(input.url).searchParams);')
      .replace('else if (queryMethod) { query = parsed.data; }',String.raw`else if (queryMethod) {
        query = parsed.data;
        for (const entryKey of Object.keys(originalQuery)) {
          if (/\d+$/.test(entryKey) && !(entryKey in query)) { query[entryKey] = originalQuery[entryKey]; }
        }
      }`);
    const fixture=makeWriteFixture({'package.json':JSON.stringify({...manifest,...(scripts===undefined?{}:{scripts})}),
      'pnpm-lock.yaml':lock,'src/parser.ts':parser,'src/app/read/route.ts':getRoute});
    try{
      const project=new WriteSource(ts,fixture.root,DEFAULT_LIMITS);
      const file=project.parse('src/parser.ts'); const nodes:ts.ElementAccessExpression[]=[];
      const visit=(node:ts.Node):void=>{
        if(ts.isElementAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='query')nodes.push(node);
        ts.forEachChild(node,visit);
      };visit(file);const node=nodes[0];assert.ok(node);
      assert.equal(permitsQueryDataCopy(project,node),scripts===undefined);
    }finally{fixture.dispose();}
  });
