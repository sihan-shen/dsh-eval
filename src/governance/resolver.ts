import { assertTemplateOfflineV1CorpusManifest } from './corpus.js'
import type {
  ArmMetricObservationV1,
  EvaluationArmV1,
  EvaluationEvidenceV1,
  EvaluationPairV1,
  EvaluationRunRefV1,
  OfflineEvidenceResolverInputV1,
  ResolvedRunEvidenceV1,
  TemplateArtifactV1,
} from './contracts.js'
import { deriveGovernanceEvaluation, evaluateGovernanceEvidence } from './evaluator.js'
import { TEMPLATE_OFFLINE_V1_POLICY_REF } from './policy.js'
import { validateOfflineEvidenceResolverInputV1 } from './validate.js'

export { evaluateGovernanceEvidence } from './evaluator.js'

function completeRun(run: ResolvedRunEvidenceV1): boolean {
  if (!run.seal || !run.annotation || !run.seal.complete || run.seal.lostCount !== 0) return false
  if (run.seal.observationCount !== run.observations.length) return false
  return run.observations.every((observation, index) => observation.seq === index + 1)
}

function runRef(run: ResolvedRunEvidenceV1): EvaluationRunRefV1 {
  return run.ref
}

function buildArm(
  artifact: TemplateArtifactV1,
  fixtureCount: number,
  runs: readonly ResolvedRunEvidenceV1[],
  metrics: ArmMetricObservationV1[],
): EvaluationArmV1 {
  const completeRuns = runs.filter(completeRun)
  return {
    artifact,
    corpusRevision: '1',
    runs: runs.map(runRef),
    fixtureRuns: fixtureCount,
    resolvedRuns: runs.length,
    completeRuns: completeRuns.length,
    incompleteRuns: fixtureCount - completeRuns.length,
    excludedRuns: 0,
    metrics,
  }
}

export function resolveOfflineEvidence(input: OfflineEvidenceResolverInputV1): EvaluationEvidenceV1 {
  const admitted = validateOfflineEvidenceResolverInputV1(input)
  const corpusManifest = assertTemplateOfflineV1CorpusManifest(admitted.corpusManifest)
  const fixtureCount = corpusManifest.fixtures.length
  const baseCompleteRuns = admitted.baseRuns.filter(completeRun)
  const variantCompleteRuns = admitted.variantRuns.filter(completeRun)
  const baseByTuple = new Map(baseCompleteRuns.map(run => [tupleKey(run.ref), run.ref]))
  const variantByTuple = new Map(variantCompleteRuns.map(run => [tupleKey(run.ref), run.ref]))
  const pairs: EvaluationPairV1[] = corpusManifest.fixtures.flatMap(fixture => {
    const baseRun = baseByTuple.get(tupleKey(fixture))
    const variantRun = variantByTuple.get(tupleKey(fixture))
    return baseRun && variantRun
      ? [{ fixtureId: fixture.fixtureId, fixtureRevision: fixture.fixtureRevision, pairingKey: fixture.pairingKey, baseRun, variantRun }]
      : []
  })
  const evaluated = deriveGovernanceEvaluation({
    baseCompleteRuns,
    variantCompleteRuns,
    fixtureRuns: fixtureCount,
    pairCount: pairs.length,
  })
  const baseArm = buildArm(admitted.baseArtifact, fixtureCount, admitted.baseRuns, evaluated.baseMetrics)
  const variantArm = buildArm(admitted.variantArtifact, fixtureCount, admitted.variantRuns, evaluated.variantMetrics)
  const evidence: EvaluationEvidenceV1 = {
    schemaVersion: 1,
    policy: { ...TEMPLATE_OFFLINE_V1_POLICY_REF },
    corpusId: corpusManifest.corpusId,
    corpusRevision: corpusManifest.corpusRevision,
    corpusManifestDigest: corpusManifest.corpusManifestDigest,
    resolverInput: admitted,
    baseArm,
    variantArm,
    pairs,
    comparisons: evaluated.comparisons,
    result: evaluated.result,
  }
  return evaluateGovernanceEvidence(evidence)
}

function tupleKey(value: { fixtureId: string, fixtureRevision: string, pairingKey: string }): string {
  return `${value.fixtureId}\u0000${value.fixtureRevision}\u0000${value.pairingKey}`
}
