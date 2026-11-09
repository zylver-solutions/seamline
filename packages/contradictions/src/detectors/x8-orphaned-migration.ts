/** X8 compares a reference with its fact-certified historical replay state. */
import type { GraphView } from '@seamline/ontology';
import { defineDetector, type FindingDraft } from '../detector.ts';
import { whereFrom } from '../graph.ts';
import { SCOPE_DATA } from '../scopes.ts';
import { readReplayEvidence } from './x8-replay-proof.ts';

export const x8OrphanedMigration = defineDetector({
  code: 'X8_ORPHANED_MIGRATION',
  severity: 'low',
  requiredScopes: [SCOPE_DATA],
  description: 'A local table or column is absent at the point a checked migration reference requires it.',
  unknownWhen(g: GraphView): string | undefined {
    const answer = readReplayEvidence(g);
    return answer.findings.length === 0 && answer.withheld.length > 0 ? answer.withheld.join('; ') : undefined;
  },
  notes(g: GraphView): readonly string[] {
    const answer = readReplayEvidence(g);
    return [...answer.withheld, ...(answer.external ? [`${answer.external} external reference site(s) have no local creation witness and are withheld`] : [])];
  },
  find(g: GraphView): readonly FindingDraft[] {
    const { findings } = readReplayEvidence(g);
    const missingTables = new Set(findings.filter((finding) => finding.row[2] === null).map((finding) => JSON.stringify([finding.reference.id, finding.row[0], finding.row[1], finding.row[3], finding.row[4]])));
    return findings.filter((finding) => finding.row[2] === null || !missingTables.has(JSON.stringify([finding.reference.id, finding.row[0], finding.row[1], finding.row[3], finding.row[4]]))).map(({ reference, creation, row }) => {
      const target = row.slice(0, 3).filter((part) => part !== null).map((part) => JSON.stringify(part)).join('.');
      return {
        left: reference.id,
        right: creation.id,
        claim: `migration ${reference.name} requires ${target}, absent at step ${row[3]} in the declared migration replay`,
        leftFact: `${reference.name} records the required reference at line ${row[4]} (${whereFrom(reference)})`,
        rightFact: `${creation.name} declares the local object at step ${row[6]}, line ${row[7]}; the matching replay snapshot certifies its absence at the reference`,
        viaPath: [], confidence: 1,
      };
    });
  },
});
