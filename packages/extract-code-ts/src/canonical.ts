/**
 * Path-free canonical names.
 *
 * Design v3 §2.1: a node's id is `{repo}:{kind}:{canonicalName}` and the
 * canonical name must NOT embed the file path, so that `git mv` renames a file
 * without orphaning every symbol declared in it. This is the defect that got
 * the previous design blocked, so the rule is enforced here mechanically rather
 * than left to each call site: `assertPathFree` runs on every canonical name
 * before it becomes an id.
 *
 * `File` is the one documented exception — the repo-relative path IS the
 * natural name of a file — so it has its own constructor below.
 *
 * The shape is `{module}#{declarationChain}`:
 *
 *   @acme/api#UserService.findById     method on an exported class
 *   @acme/api#User.email               a field (kind disambiguates from a
 *                                      nested symbol of the same chain)
 *   @acme/api#UserService.findById(0)id  a parameter
 *
 * `module` is the nearest `package.json` name, which survives a file move
 * inside the package. Moving a file to a different package legitimately
 * changes the symbol's identity; only file renames are aliased today, so that
 * move is not linked to the old id.
 *
 * The scheme itself (`symbolCanonicalName`, `codeFieldCanonicalName`,
 * `parameterCanonicalName`, `ROOT_MODULE`) is defined once, in
 * `@seamline/core`'s identity module, so the ids stored here and the ids the
 * alias layer builds cannot drift apart. This module adds the extractor's own
 * path check on top.
 */

import { nodeId } from '@seamline/ontology';
import type { NodeId, NodeKind } from '@seamline/ontology';
import {
  codeFieldCanonicalName,
  parameterCanonicalName,
  ROOT_MODULE,
  symbolCanonicalName,
} from '@seamline/core/identity';

export { codeFieldCanonicalName, parameterCanonicalName, ROOT_MODULE, symbolCanonicalName };

/**
 * What "embeds a path" actually means, spelled out rather than approximated by
 * banning `/`: a scoped package name (`@acme/api`) and an HTTP route
 * (`GET /users/:id`) both legitimately contain a slash and neither is a
 * filesystem path. What is banned is a relative or absolute filesystem
 * reference, a Windows separator, a drive letter, or a source-file extension.
 */
const PATH_ISH = /(?:^|[#(\s])\.{1,2}\/|\\|^\/|^[A-Za-z]:[\\/]|\/[^\s#]*\.(?:d\.ts|[cm]?tsx?|[cm]?jsx?)(?=$|[\s#])/;
// A bare `.ts` is NOT a marker: `Config.ts` is a field named `ts`, and throwing
// on it would crash the extractor on legitimate code. Only a slash-qualified
// filename counts.

/**
 * Reject a canonical name that smells like a path.
 *
 * Deliberately a throw and not a diagnostic: a path leaking into an id is
 * silent data corruption that only shows up as an orphaned node several runs
 * later, and there is no case in which continuing is better than stopping.
 */
export function assertPathFree(canonicalName: string, kind: NodeKind): void {
  if (kind === 'File') return;
  if (canonicalName.length === 0) throw new Error(`empty canonical name for ${kind}`);
  if (PATH_ISH.test(canonicalName)) {
    throw new Error(`canonical name for ${kind} embeds a path: ${canonicalName}`);
  }
}

function make(repo: string, kind: NodeKind, canonicalName: string): NodeId {
  assertPathFree(canonicalName, kind);
  return nodeId(repo, kind, canonicalName);
}

export function repoId(repo: string): NodeId {
  return make(repo, 'Repo', repo);
}

/** The documented exception: a file's natural name is its repo-relative POSIX path. */
export function fileId(repo: string, repoRelativePath: string): NodeId {
  if (repoRelativePath.includes('\\') || repoRelativePath.startsWith('/')) {
    throw new Error(`file path must be repo-relative POSIX: ${repoRelativePath}`);
  }
  return nodeId(repo, 'File', repoRelativePath);
}

export function moduleId(repo: string, moduleName: string): NodeId {
  return make(repo, 'Module', moduleName);
}

export function symbolId(repo: string, canonicalName: string): NodeId {
  return make(repo, 'Symbol', canonicalName);
}

export function codeFieldId(repo: string, canonicalName: string): NodeId {
  return make(repo, 'CodeField', canonicalName);
}

export function parameterId(repo: string, canonicalName: string): NodeId {
  return make(repo, 'Parameter', canonicalName);
}

/** A route's natural name is the route itself, which is already path-free of the filesystem. */
export function routeCanonicalName(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

export function routeHandlerId(repo: string, canonicalName: string): NodeId {
  // A URL route legitimately contains `/`; it is not a filesystem path.
  if (canonicalName.includes('\\')) throw new Error(`route contains a backslash: ${canonicalName}`);
  return nodeId(repo, 'RouteHandler', canonicalName);
}
