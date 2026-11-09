/**
 * The five tools. There is no sixth, and in particular there is no raw-query
 * tool: v3 §2.6 removes `cypher` from the store interface because on the
 * Postgres/AGE adapter it was arbitrary query execution inside the database.
 */

import { contextTool } from './context.ts';
import { contradictionsTool } from './contradictions.ts';
import { explainTool } from './explain.ts';
import { impactTool } from './impact.ts';
import { lineageTool } from './lineage.ts';
import type { ToolDefinition } from './registry.ts';

export const TOOLS: readonly ToolDefinition<never>[] = [
  contextTool as unknown as ToolDefinition<never>,
  impactTool as unknown as ToolDefinition<never>,
  lineageTool as unknown as ToolDefinition<never>,
  contradictionsTool as unknown as ToolDefinition<never>,
  explainTool as unknown as ToolDefinition<never>,
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export function findTool(name: string): ToolDefinition<never> | undefined {
  return TOOLS.find((t) => t.name === name);
}

export { contextTool, impactTool, lineageTool, contradictionsTool, explainTool };
export type { ToolContext, ToolDefinition } from './registry.ts';
