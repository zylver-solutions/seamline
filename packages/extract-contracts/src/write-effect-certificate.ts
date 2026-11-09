// SPDX-License-Identifier: Apache-2.0
/** Production catalog boundary. Repository metadata cannot supply a certificate. */
import type * as TS from 'typescript';
import { LIBRARY_EFFECT_CERTIFICATES } from './write-effect-catalog.ts';
import { verifyEffectClosure } from './write-effect-closure.ts';
import { assertEffectUse } from './write-effect-use.ts';
import { assertWriteScriptOrigins } from './write-script-origins.ts';
import { readLockedPackage } from './write-libraries.ts';
import { record, type WriteSource, WriteUnknown } from './write-source.ts';

export function tryLibraryEffectCertificate(project: WriteSource, file: TS.SourceFile,
  specifier: TS.Expression | undefined): boolean {
  project.assertBudget();
  if (specifier === undefined || !project.ts.isStringLiteral(specifier)) return false;
  const name = specifier.text;
  const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0] as string;
  const certificate = LIBRARY_EFFECT_CERTIFICATES.get(packageName);
  if (certificate === undefined) return false;
  if (name !== packageName) throw new WriteUnknown('WRITE_EFFECT_CERTIFICATE_ENTRY_UNKNOWN', specifier);
  if (!project.inventoryComplete) throw new WriteUnknown('WRITE_SOURCE_INVENTORY_INCOMPLETE');
  assertWriteScriptOrigins(project);
  const owner = project.owner(file);
  const loaderUnknown = (): never => { throw new WriteUnknown('WRITE_EFFECT_CERTIFICATE_LOADER_UNKNOWN', specifier); };
  if (owner.manifest['browser'] !== undefined || owner.manifest['babel'] !== undefined || owner.manifest['swc'] !== undefined ||
      project.inventory.some(path => /(?:^|\/)(?:\.babelrc(?:\.[^/]+)?|babel\.config\.[^/]+|\.swcrc|swc\.config\.[^/]+)$/.test(path)))
    loaderUnknown();
  // Explicit repository loader hooks contradict the ordinary-loader witness.
  for (const path of project.inventory) {
    if (/(?:^|\/)[tj]sconfig\.json$/.test(path)) {
      const config = project.structured(path, text => {
        const parsed = project.ts.parseConfigFileTextToJson(path, text);
        if (parsed.error !== undefined || !record(parsed.config) || parsed.config['extends'] !== undefined) return loaderUnknown();
        return parsed.config;
      });
      const options = config['compilerOptions'];
      if (record(options) && options['plugins'] !== undefined) loaderUnknown();
    }
  }
  const context = readLockedPackage(project, file, packageName);
  if (context.rootManifest['pnpm'] !== undefined && !record(context.rootManifest['pnpm']))
    throw new WriteUnknown('WRITE_ARTIFACT_CUSTOMIZED');
  project.memoize(`effect-certificate:${certificate.id}:${context.lockPath}:${context.snapshot}`, () => {
    verifyEffectClosure(project, context, certificate);
  });
  assertEffectUse(project, file, specifier);
  return true;
}
