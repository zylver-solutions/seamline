/** Independently pinned proof-v2 model admission. No producer transition/parser is imported. */
export const CORE_MODEL = ['declared-ddl-core-v2', '5748cb97c26ed635672e73c87773d3b0cb6194d5086c9292936abb25dc0db49f'] as const;
export const PG17_MODEL = ['postgresql-17.12-stock-source-local-v1', 'e631b9ee69943164713b490db76177abf3de8f3994d2aa62bf5844523c6dde5c'] as const;
export const MODEL_REGISTRY_HASH = '8b936bdb4e8522c83c01ec0aae7584a60dcaba33870d6603ac36a1d76e9dbba5';
export function approvedReplayModel(id: unknown, hash: unknown, selector: unknown): boolean {
  const model = selector === 17 ? PG17_MODEL : selector === null ? CORE_MODEL : undefined;
  return model !== undefined && id === model[0] && hash === model[1];
}
export const REPLAY_BODY_FIELDS: readonly string[] = [
  "externalRefCount",
  "externalRefs",
  "replayAbortPossible",
  "replayConfigHash",
  "replayContinuation",
  "replayDeclarationCount",
  "replayDeclarations",
  "replayGroup",
  "replayInputHash",
  "replayInventoryComplete",
  "replayModelHash",
  "replayModelId",
  "replayNativeState",
  "replayOrderPolicy",
  "replayOrdinal",
  "replayReferenceCount",
  "replaySelector",
  "replayStepCount",
  "replayUnknownStepCount",
  "replayUnknownSteps",
  "replayVersion",
  "skippedRefCount",
  "skippedRefs",
  "unknownRefCount",
  "unknownRefs",
  "unresolvedRefCount",
  "unresolvedRefs",
  "validRefCount",
  "validRefs"
];
