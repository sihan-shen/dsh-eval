import { canonicalGovernanceJson } from './canonical.js'
import { assertTemplateOfflineV1CorpusManifest } from './corpus.js'
import type {
  ArmMetricObservationV1,
  EvaluationArmV1,
  EvaluationEvidenceV1,
  EvaluationPairV1,
  EvaluationRunRefV1,
  MetricComparisonV1,
  OfflineEvidenceResolverInputV1,
  ResolvedRunEvidenceV1,
  TemplateArtifactV1,
} from './contracts.js'
import { TEMPLATE_OFFLINE_V1_POLICY, TEMPLATE_OFFLINE_V1_POLICY_REF } from './policy.js'
import { validateEvaluationEvidenceV1 } from './validate.js'

type MetricName = typeof TEMPLATE_OFFLINE_V1_POLICY.metrics[number]['name']

export type GovernanceEvaluationInput = {
  baseCompleteRuns: readonly ResolvedRunEvidenceV1[]
  variantCompleteRuns: readonly ResolvedRunEvidenceV1[]
  fixtureRuns: number
  pairCount: number
}

export type GovernanceEvaluationOutput = {
  baseMetrics: ArmMetricObservationV1[]
  variantMetrics: ArmMetricObservationV1[]
  comparisons: MetricComparisonV1[]
  result: EvaluationEvidenceV1['result']
}

function unavailableMetric(name: MetricName, eligibleRuns: number): ArmMetricObservationV1 {
  return {
    name,
    value: null,
    numerator: 0,
    denominator: 0,
    observedRuns: 0,
    eligibleRuns,
    basis: 'unavailable',
  }
}

function checkedIncrement(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) {
    throw new TypeError('governance evaluator arithmetic overflow')
  }
  return value + 1
}

function checkedProduct(left: number, right: number): number {
  const product = left * right
  if (!Number.isFinite(product)) throw new TypeError('governance evaluator arithmetic overflow')
  return product
}

function checkedDelta(variantValue: number, baseValue: number): number {
  const delta = variantValue - baseValue
  if (!Number.isFinite(delta)) throw new TypeError('governance evaluator arithmetic overflow')
  return delta
}

function observedRate(
  name: Extract<MetricName, 'task_success_rate' | 'accepted_result_rate'>,
  numerator: number,
  denominator: number,
  eligibleRuns: number,
): ArmMetricObservationV1 {
  if (denominator === 0) return unavailableMetric(name, eligibleRuns)
  return {
    name,
    value: numerator / denominator,
    numerator,
    denominator,
    observedRuns: denominator,
    eligibleRuns,
    basis: 'observed',
  }
}

function deriveMetrics(runs: readonly ResolvedRunEvidenceV1[]): ArmMetricObservationV1[] {
  const eligibleRuns = runs.length
  if (!Number.isSafeInteger(eligibleRuns) || eligibleRuns < 0) {
    throw new TypeError('governance evaluator arithmetic overflow')
  }

  let knownOutcomes = 0
  let successfulOutcomes = 0
  let explicitAcceptance = 0
  let acceptedResults = 0
  let verificationDuration = 0
  let verificationRuns = 0
  let verificationOverflow = false
  const maximumDuration = TEMPLATE_OFFLINE_V1_POLICY.metrics[2]!.accumulation!.maximum

  for (const run of runs) {
    const annotation = run.annotation
    if (!annotation) throw new TypeError('governance evaluator complete run missing annotation')

    if (annotation.outcome !== 'unknown') {
      knownOutcomes = checkedIncrement(knownOutcomes, eligibleRuns)
      if (annotation.outcome === 'success') {
        successfulOutcomes = checkedIncrement(successfulOutcomes, eligibleRuns)
      }
    }
    if (annotation.accepted !== null) {
      explicitAcceptance = checkedIncrement(explicitAcceptance, eligibleRuns)
      if (annotation.accepted) acceptedResults = checkedIncrement(acceptedResults, eligibleRuns)
    }

    let hasVerificationDuration = false
    for (const observation of run.observations) {
      if (observation.kind !== 'verification-finished' || observation.facts.durationMs === undefined) continue
      hasVerificationDuration = true
      const duration = observation.facts.durationMs
      if (verificationDuration > maximumDuration - duration) {
        verificationOverflow = true
      } else if (!verificationOverflow) {
        verificationDuration += duration
      }
    }
    if (hasVerificationDuration) verificationRuns = checkedIncrement(verificationRuns, eligibleRuns)
  }

  const verificationCost = verificationOverflow
    ? unavailableMetric('verification_cost', 0)
    : verificationRuns === 0
      ? unavailableMetric('verification_cost', eligibleRuns)
      : {
          name: 'verification_cost',
          value: verificationDuration / verificationRuns,
          numerator: verificationDuration,
          denominator: verificationRuns,
          observedRuns: verificationRuns,
          eligibleRuns,
          basis: 'observed' as const,
        }

  const byName: Record<MetricName, ArmMetricObservationV1> = {
    task_success_rate: observedRate(
      'task_success_rate',
      successfulOutcomes,
      knownOutcomes,
      eligibleRuns,
    ),
    accepted_result_rate: observedRate(
      'accepted_result_rate',
      acceptedResults,
      explicitAcceptance,
      eligibleRuns,
    ),
    verification_cost: verificationCost,
  }
  return TEMPLATE_OFFLINE_V1_POLICY.metrics.map(metric => byName[metric.name])
}

function metricAvailable(
  metric: ArmMetricObservationV1,
  policy: typeof TEMPLATE_OFFLINE_V1_POLICY.metrics[number],
): boolean {
  if (metric.value === null || metric.eligibleRuns === 0) return false
  if (!policy.permittedBasis.some(basis => basis === metric.basis)) return false
  const coverage = metric.observedRuns / metric.eligibleRuns
  return Number.isFinite(coverage) && coverage >= policy.minimumCoverage
}

function deriveComparisons(
  baseMetrics: readonly ArmMetricObservationV1[],
  variantMetrics: readonly ArmMetricObservationV1[],
): MetricComparisonV1[] {
  return TEMPLATE_OFFLINE_V1_POLICY.metrics.map((policy, index): MetricComparisonV1 => {
    const baseMetric = baseMetrics[index]!
    const variantMetric = variantMetrics[index]!
    if (!metricAvailable(baseMetric, policy) || !metricAvailable(variantMetric, policy)) {
      return {
        name: policy.name,
        baseValue: null,
        variantValue: null,
        delta: null,
        result: 'unavailable',
      }
    }

    const baseValue = baseMetric.value!
    const variantValue = variantMetric.value!
    const delta = checkedDelta(variantValue, baseValue)
    const passed = policy.name === 'verification_cost'
      ? variantValue <= checkedProduct(baseValue, policy.threshold.variantLteBaseTimes!)
      : delta >= policy.threshold.deltaGte!
    return {
      name: policy.name,
      baseValue,
      variantValue,
      delta,
      result: passed ? 'pass' : 'fail',
    }
  })
}

function deriveResult(
  input: GovernanceEvaluationInput,
  comparisons: readonly MetricComparisonV1[],
): EvaluationEvidenceV1['result'] {
  if (comparisons.some(comparison => comparison.result === 'fail')) return 'failed'

  const requiredUnavailable = TEMPLATE_OFFLINE_V1_POLICY.metrics.some((policy, index) => (
    policy.required && comparisons[index]?.result === 'unavailable'
  ))
  const completeCoverage = input.fixtureRuns > 0
    && input.pairCount / input.fixtureRuns >= TEMPLATE_OFFLINE_V1_POLICY.requiredPairCoverage
    && input.baseCompleteRuns.length === input.fixtureRuns
    && input.variantCompleteRuns.length === input.fixtureRuns
  return !completeCoverage || requiredUnavailable ? 'incomplete' : 'passed'
}

export function deriveGovernanceEvaluation(input: GovernanceEvaluationInput): GovernanceEvaluationOutput {
  for (const count of [
    input.baseCompleteRuns.length,
    input.variantCompleteRuns.length,
    input.fixtureRuns,
    input.pairCount,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0 || count > input.fixtureRuns) {
      throw new TypeError('governance evaluator count out of bounds')
    }
  }

  const baseMetrics = deriveMetrics(input.baseCompleteRuns)
  const variantMetrics = deriveMetrics(input.variantCompleteRuns)
  const comparisons = deriveComparisons(baseMetrics, variantMetrics)
  return {
    baseMetrics,
    variantMetrics,
    comparisons,
    result: deriveResult(input, comparisons),
  }
}

function completeRun(run: ResolvedRunEvidenceV1): boolean {
  if (!run.seal || !run.annotation || !run.seal.complete || run.seal.lostCount !== 0) return false
  if (run.seal.observationCount !== run.observations.length) return false
  return run.observations.every((observation, index) => observation.seq === index + 1)
}

function tupleKey(value: { fixtureId: string, fixtureRevision: string, pairingKey: string }): string {
  return `${value.fixtureId}\u0000${value.fixtureRevision}\u0000${value.pairingKey}`
}

function runRef(run: ResolvedRunEvidenceV1): EvaluationRunRefV1 {
  return run.ref
}

function buildArm(
  artifact: TemplateArtifactV1,
  fixtureRuns: number,
  runs: readonly ResolvedRunEvidenceV1[],
  metrics: ArmMetricObservationV1[],
): EvaluationArmV1 {
  const completeRuns = runs.filter(completeRun)
  return {
    artifact,
    corpusRevision: '1',
    runs: runs.map(runRef),
    fixtureRuns,
    resolvedRuns: runs.length,
    completeRuns: completeRuns.length,
    incompleteRuns: fixtureRuns - completeRuns.length,
    excludedRuns: 0,
    metrics,
  }
}

function expectedEvidence(input: OfflineEvidenceResolverInputV1): EvaluationEvidenceV1 {
  const fixtureRuns = input.corpusManifest.fixtures.length
  const baseCompleteRuns = input.baseRuns.filter(completeRun)
  const variantCompleteRuns = input.variantRuns.filter(completeRun)
  const baseByTuple = new Map(baseCompleteRuns.map(run => [tupleKey(run.ref), run.ref]))
  const variantByTuple = new Map(variantCompleteRuns.map(run => [tupleKey(run.ref), run.ref]))
  const pairs: EvaluationPairV1[] = input.corpusManifest.fixtures.flatMap(fixture => {
    const baseRun = baseByTuple.get(tupleKey(fixture))
    const variantRun = variantByTuple.get(tupleKey(fixture))
    return baseRun && variantRun
      ? [{
          fixtureId: fixture.fixtureId,
          fixtureRevision: fixture.fixtureRevision,
          pairingKey: fixture.pairingKey,
          baseRun,
          variantRun,
        }]
      : []
  })
  const evaluated = deriveGovernanceEvaluation({
    baseCompleteRuns,
    variantCompleteRuns,
    fixtureRuns,
    pairCount: pairs.length,
  })
  return {
    schemaVersion: 1,
    policy: { ...TEMPLATE_OFFLINE_V1_POLICY_REF },
    corpusId: input.corpusManifest.corpusId,
    corpusRevision: input.corpusManifest.corpusRevision,
    corpusManifestDigest: input.corpusManifest.corpusManifestDigest,
    resolverInput: input,
    baseArm: buildArm(input.baseArtifact, fixtureRuns, input.baseRuns, evaluated.baseMetrics),
    variantArm: buildArm(input.variantArtifact, fixtureRuns, input.variantRuns, evaluated.variantMetrics),
    pairs,
    comparisons: evaluated.comparisons,
    result: evaluated.result,
  }
}

/** Revalidate and replay every policy-derived assertion in serialized governance evidence. */
export function evaluateGovernanceEvidence(evidence: EvaluationEvidenceV1): EvaluationEvidenceV1 {
  const admitted = validateEvaluationEvidenceV1(evidence)
  if (canonicalGovernanceJson(admitted.policy) !== canonicalGovernanceJson(TEMPLATE_OFFLINE_V1_POLICY_REF)) {
    throw new TypeError('governance evaluator policy identity mismatch')
  }
  assertTemplateOfflineV1CorpusManifest(admitted.resolverInput.corpusManifest)

  const expected = expectedEvidence(admitted.resolverInput)
  if (canonicalGovernanceJson(admitted) !== canonicalGovernanceJson(expected)) {
    throw new TypeError('governance evaluator derived evidence mismatch')
  }
  return admitted
}
