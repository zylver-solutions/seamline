// SPDX-License-Identifier: Apache-2.0
/** Import origins must supply inspected source or an existing effect summary. */
import type * as TS from 'typescript';
import { tryLibraryEffectCertificate } from './write-effect-certificate.ts';
import { lockedVersion } from './write-libraries.ts';
import { metadataLoads } from './write-metadata-loads.ts';
import { assertNativeCapabilitySummary } from './write-native-capabilities.ts';
import { sourceImport } from './write-query-copy-world.ts';
import { WriteUnknown, type WriteSource } from './write-source.ts';

export function assertWriteImportEffects(project: WriteSource, file: TS.SourceFile,
  specifier: TS.Expression | undefined): void {
  const ts = project.ts;
  if (specifier === undefined || !ts.isStringLiteral(specifier))
    throw new WriteUnknown('WRITE_LIBRARY_EFFECTS_UNKNOWN', specifier ?? file);
  const name = specifier.text;
  if (/[\u0000-\u0020\u007f?#%\\]/.test(name) || name.startsWith('/') ||
      (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) && !name.startsWith('node:')))
    throw new WriteUnknown('WRITE_LIBRARY_EFFECTS_UNKNOWN', specifier);
  assertNativeCapabilitySummary(name, specifier);
  if (tryLibraryEffectCertificate(project, file, specifier)) return;
  const declaration = ts.isImportDeclaration(specifier.parent) ? specifier.parent : undefined;
  if (['module', 'node:module', 'path', 'node:path'].includes(name)) {
    if (declaration === undefined) throw new WriteUnknown('WRITE_LIBRARY_EFFECTS_UNKNOWN', specifier);
    metadataLoads(project, file);
    return;
  }
  if (['zod', 'zod/v4'].includes(name)) {
    if (lockedVersion(project, file, 'zod') !== '4.3.6')
      throw new WriteUnknown('WRITE_REVIEWED_ARTIFACT_MISMATCH', specifier);
    return;
  }
  if (name === '@prisma/extension-read-replicas') {
    if (lockedVersion(project, file, name) !== '0.5.0')
      throw new WriteUnknown('WRITE_REVIEWED_ARTIFACT_MISMATCH', specifier);
    return;
  }
  if (name === 'next-intl/plugin') {
    const owner = project.owner(file);
    if (!['ts', 'mjs', 'js', 'cjs'].some(extension => project.path(owner.directory, `next.config.${extension}`) ===
        project.path(project.root, file.fileName)) || lockedVersion(project, file, 'next-intl') !== '4.9.2')
      throw new WriteUnknown('WRITE_LIBRARY_EFFECTS_UNKNOWN', specifier);
    return;
  }
  // Relative node_modules paths do not become inspected package sources.
  sourceImport(project, file, name, specifier, declaration, 'WRITE_LIBRARY_EFFECTS_UNKNOWN');
}
