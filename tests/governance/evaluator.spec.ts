import type { ObservationV1, RunAnnotationV1, RunSealV1 } from '@han_05/dsh-telemetry/contracts'
import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST,
  evaluateGovernanceEvidence,
  resolveOfflineEvidence,
  sha256Canonical,
  type EvaluationEvidenceV1,
  type OfflineEvidenceResolverInputV1,
  type ResolvedRunEvidenceV1,
  type TemplateArtifactV1,
} from '../../src/governance/index.js'

const ref = (digit: string): string => digit.repeat(64)

function artifact(seed: string): TemplateArtifactV1 {
  const body = {
    schemaVersion: 1 as const,
    ref: { schemaVersion: 1 as const, surface: 'template' as const, version: '1.0.0', digest: ref(seed) },
    configHash: ref(seed === 'a' ? 'b' : 'c'),
    promptHash: ref(seed === 'a' ? 'd' : 'e'),
  }
  return { ...body, bindingDigest: sha256Canonical(body) }
}

type RunOptions = {
  outcome?: RunAnnotationV1['outcome']
  accepted?: RunAnnotationV1['accepted']
  durations?: readonly (number | undefined)[]
}

function run(
  domainRef: string,
  runRef: string,
  fixtureIndex: number,
  selectedArtifact: TemplateArtifactV1,
  options: RunOptions = {},
): ResolvedRunEvidenceV1 {
  const fixture = TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[fixtureIndex]!
  const observations: ObservationV1[] = [
    {
      schemaVersion: 1,
      domainRef,
      runRef,
      sessionRef: ref('f'),
      seq: 1,
      kind: 'run-started',
      observedAtMs: 1,
      facts: { routeRef: ref('1'), scope: 'root' },
    },
    ...(options.durations ?? [10]).map((durationMs, index): ObservationV1 => ({
      schemaVersion: 1,
      domainRef,
      runRef,
      sessionRef: ref('f'),
      seq: index + 2,
      kind: 'verification-finished',
      observedAtMs: index + 2,
      facts: {
        status: 'passed',
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    })),
  ]
  const annotation: RunAnnotationV1 = {
    schemaVersion: 1,
    domainRef,
    runRef,
    taskInstanceRef: fixture.taskInstanceRef,
    taskFamilyRef: fixture.taskFamilyRef,
    configHash: selectedArtifact.configHash,
    promptHash: selectedArtifact.promptHash,
    outcome: options.outcome ?? 'success',
    accepted: options.accepted === undefined ? true : options.accepted,
    failure: options.outcome === 'failure'
      ? { category: 'verification_gap', evidence: [{ runRef, seq: 1 }], attribution: 'reviewed' }
      : null,
    evidence: [{ runRef, seq: 1 }],
  }
  const seal: RunSealV1 = {
    schemaVersion: 1,
    kind: 'run-seal',
    domainRef,
    runRef,
    observationCount: observations.length,
    lostCount: 0,
    complete: true,
  }
  return {
    ref: {
      domainRef,
      runRef,
      fixtureId: fixture.fixtureId,
      fixtureRevision: fixture.fixtureRevision,
      pairingKey: fixture.pairingKey,
    },
    observations,
    seal,
    annotation,
  }
}

function input(
  baseOptions: readonly RunOptions[] = [{}, {}],
  variantOptions: readonly RunOptions[] = [{}, {}],
): OfflineEvidenceResolverInputV1 {
  const baseArtifact = artifact('a')
  const variantArtifact = artifact('e')
  const baseRuns = TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures.map((fixture, index) =>
    run(fixture.baseDomainRef, ref(String(index + 1)), index, baseArtifact, baseOptions[index]))
  const variantRuns = TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures.map((fixture, index) =>
    run(fixture.variantDomainRef, ref(String(index + 3)), index, variantArtifact, variantOptions[index]))
  return {
    schemaVersion: 1,
    corpusManifest: structuredClone(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST) as OfflineEvidenceResolverInputV1['corpusManifest'],
    baseArtifact,
    variantArtifact,
    baseRuns,
    variantRuns,
  }
}

function evaluated(candidate: OfflineEvidenceResolverInputV1): EvaluationEvidenceV1 {
  return evaluateGovernanceEvidence(resolveOfflineEvidence(candidate))
}

function cloneEvidence(evidence: EvaluationEvidenceV1): EvaluationEvidenceV1 {
  return structuredClone(evidence) as EvaluationEvidenceV1
}

describe('revision-1 governance policy evaluator', () => {
  it('derives successful-known-outcome, explicit-acceptance, and verification-duration metrics', () => {
    const evidence = evaluated(input(
      [
        { outcome: 'success', accepted: true, durations: [10] },
        { outcome: 'failure', accepted: false, durations: [30] },
      ],
      [
        { outcome: 'failure', accepted: false, durations: [20] },
        { outcome: 'success', accepted: true, durations: [20] },
      ],
    ))

    expect(evidence.baseArm.metrics).toEqual([
      { name: 'task_success_rate', value: 0.5, numerator: 1, denominator: 2, observedRuns: 2, eligibleRuns: 2, basis: 'observed' },
      { name: 'accepted_result_rate', value: 0.5, numerator: 1, denominator: 2, observedRuns: 2, eligibleRuns: 2, basis: 'observed' },
      { name: 'verification_cost', value: 20, numerator: 40, denominator: 2, observedRuns: 2, eligibleRuns: 2, basis: 'observed' },
    ])
    expect(evidence.comparisons).toEqual([
      { name: 'task_success_rate', baseValue: 0.5, variantValue: 0.5, delta: 0, result: 'pass' },
      { name: 'accepted_result_rate', baseValue: 0.5, variantValue: 0.5, delta: 0, result: 'pass' },
      { name: 'verification_cost', baseValue: 20, variantValue: 20, delta: 0, result: 'pass' },
    ])
    expect(evidence.result).toBe('passed')
  })

  it('treats absent verification duration as optional unavailable evidence', () => {
    const evidence = evaluated(input(
      [{ durations: [undefined] }, { durations: [undefined] }],
      [{ durations: [undefined] }, { durations: [undefined] }],
    ))

    expect(evidence.baseArm.metrics[2]).toEqual({
      name: 'verification_cost', value: null, numerator: 0, denominator: 0,
      observedRuns: 0, eligibleRuns: 2, basis: 'unavailable',
    })
    expect(evidence.comparisons[2]).toEqual({
      name: 'verification_cost', baseValue: null, variantValue: null, delta: null, result: 'unavailable',
    })
    expect(evidence.result).toBe('passed')
  })

  it('counts explicit zero verification duration as observed', () => {
    const evidence = evaluated(input(
      [{ durations: [0] }, { durations: [0] }],
      [{ durations: [0] }, { durations: [0] }],
    ))

    expect(evidence.baseArm.metrics[2]).toEqual({
      name: 'verification_cost', value: 0, numerator: 0, denominator: 2,
      observedRuns: 2, eligibleRuns: 2, basis: 'observed',
    })
    expect(evidence.comparisons[2]).toEqual({
      name: 'verification_cost', baseValue: 0, variantValue: 0, delta: 0, result: 'pass',
    })
  })

  it('accepts an exact maximum verification-duration accumulator', () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const evidence = evaluated(input(
      [{ durations: [maximum] }, { durations: [0] }],
      [{ durations: [maximum] }, { durations: [0] }],
    ))

    expect(evidence.baseArm.metrics[2]).toEqual({
      name: 'verification_cost', value: maximum / 2, numerator: maximum, denominator: 2,
      observedRuns: 2, eligibleRuns: 2, basis: 'observed',
    })
    expect(evidence.comparisons[2].result).toBe('pass')
  })

  it('latches maximum plus one to the all-zero overflow sentinel', () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const evidence = evaluated(input(
      [{ durations: [maximum] }, { durations: [1] }],
      [{ durations: [10] }, { durations: [10] }],
    ))

    expect(evidence.baseArm.metrics[2]).toEqual({
      name: 'verification_cost', value: null, numerator: 0, denominator: 0,
      observedRuns: 0, eligibleRuns: 0, basis: 'unavailable',
    })
    expect(evidence.comparisons[2]).toEqual({
      name: 'verification_cost', baseValue: null, variantValue: null, delta: null, result: 'unavailable',
    })
    expect(evidence.result).toBe('passed')
  })

  it('makes required metric unavailability incomplete while ignoring optional unavailability', () => {
    const evidence = evaluated(input(
      [
        { outcome: 'unknown', accepted: null, durations: [undefined] },
        { outcome: 'unknown', accepted: null, durations: [undefined] },
      ],
      [
        { outcome: 'success', durations: [undefined] },
        { outcome: 'success', durations: [undefined] },
      ],
    ))

    expect(evidence.baseArm.metrics[0]).toEqual({
      name: 'task_success_rate', value: null, numerator: 0, denominator: 0,
      observedRuns: 0, eligibleRuns: 2, basis: 'unavailable',
    })
    expect(evidence.baseArm.metrics[1]).toEqual({
      name: 'accepted_result_rate', value: null, numerator: 0, denominator: 0,
      observedRuns: 0, eligibleRuns: 2, basis: 'unavailable',
    })
    expect(evidence.comparisons[0].result).toBe('unavailable')
    expect(evidence.comparisons[2].result).toBe('unavailable')
    expect(evidence.result).toBe('incomplete')
  })

  it('gives an available threshold failure precedence over omitted fixture evidence', () => {
    const candidate = input(
      [{ outcome: 'success', accepted: true, durations: [10] }, {}],
      [{ outcome: 'failure', accepted: true, durations: [10] }, {}],
    )
    candidate.baseRuns = candidate.baseRuns.slice(0, 1)
    candidate.variantRuns = candidate.variantRuns.slice(0, 1)

    const evidence = evaluated(candidate)
    expect(evidence.pairs).toHaveLength(1)
    expect(evidence.comparisons[0].result).toBe('fail')
    expect(evidence.result).toBe('failed')
  })

  it('applies the exact lower-is-better multiplier threshold', () => {
    const atThreshold = evaluated(input(
      [{ durations: [10] }, { durations: [10] }],
      [{ durations: [11] }, { durations: [11] }],
    ))
    const aboveThreshold = evaluated(input(
      [{ durations: [10] }, { durations: [10] }],
      [{ durations: [11] }, { durations: [12] }],
    ))

    expect(atThreshold.comparisons[2]).toEqual({
      name: 'verification_cost', baseValue: 10, variantValue: 11, delta: 1, result: 'pass',
    })
    expect(aboveThreshold.comparisons[2]).toEqual({
      name: 'verification_cost', baseValue: 10, variantValue: 11.5, delta: 1.5, result: 'fail',
    })
    expect(aboveThreshold.result).toBe('failed')
  })

  it('rejects altered serialized metrics, comparisons, results, ordering, and counts', () => {
    const original = resolveOfflineEvidence(input())
    const mutations: Array<(candidate: EvaluationEvidenceV1) => void> = [
      candidate => { candidate.baseArm.metrics[0]!.numerator = 0 },
      candidate => { candidate.baseArm.metrics[0]!.name = 'unknown_metric' },
      candidate => { candidate.baseArm.metrics.reverse() },
      candidate => { candidate.comparisons[0]!.result = 'fail' },
      candidate => { candidate.comparisons.reverse() },
      candidate => { candidate.result = 'failed' },
      candidate => { candidate.baseArm.completeRuns = 1 },
    ]

    for (const mutate of mutations) {
      const candidate = cloneEvidence(original)
      mutate(candidate)
      expect(() => evaluateGovernanceEvidence(candidate)).toThrow('governance validation evaluationEvidence')
    }
  })

  it('rejects stale policy and self-consistent substituted corpus identities', () => {
    const original = resolveOfflineEvidence(input())
    const stalePolicy = cloneEvidence(original)
    stalePolicy.policy.policyDigest = ref('0')
    expect(() => evaluateGovernanceEvidence(stalePolicy)).toThrow('governance evaluator policy identity mismatch')

    const staleCorpus = cloneEvidence(original)
    staleCorpus.resolverInput.corpusManifest.fixtures[0]!.fixtureInputDigest = ref('0')
    const { corpusManifestDigest: _digest, ...manifestBody } = staleCorpus.resolverInput.corpusManifest
    const substitutedDigest = sha256Canonical(manifestBody)
    staleCorpus.resolverInput.corpusManifest.corpusManifestDigest = substitutedDigest
    staleCorpus.corpusManifestDigest = substitutedDigest
    expect(() => evaluateGovernanceEvidence(staleCorpus)).toThrow('governance corpus manifest not authoritative')
  })

  it('rejects a caller-supplied non-null comparison for overflowed cost', () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const overflowed = resolveOfflineEvidence(input(
      [{ durations: [maximum] }, { durations: [1] }],
      [{ durations: [10] }, { durations: [10] }],
    ))
    overflowed.comparisons[2] = {
      name: 'verification_cost', baseValue: 0, variantValue: 0, delta: 0, result: 'pass',
    }

    expect(() => evaluateGovernanceEvidence(overflowed)).toThrow('governance validation evaluationEvidence')
  })
})
