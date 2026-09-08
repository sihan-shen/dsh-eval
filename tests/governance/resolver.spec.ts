import type { ObservationV1, RunAnnotationV1, RunSealV1 } from '@han_05/dsh-telemetry/contracts'
import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST,
  TEMPLATE_OFFLINE_V1_POLICY_DIGEST,
  evaluateGovernanceEvidence,
  sha256Canonical,
  type OfflineEvidenceResolverInputV1,
  type ResolvedRunEvidenceV1,
  type TemplateArtifactV1,
} from '../../src/governance/index.js'
import { resolveOfflineEvidence } from '../../src/governance/resolver.js'

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

function run(
  domainRef: string,
  runRef: string,
  fixtureIndex: number,
  selectedArtifact: TemplateArtifactV1,
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
    {
      schemaVersion: 1,
      domainRef,
      runRef,
      sessionRef: ref('f'),
      seq: 2,
      kind: 'verification-finished',
      observedAtMs: 2,
      facts: { status: 'passed', durationMs: 10 },
    },
  ]
  const annotation: RunAnnotationV1 = {
    schemaVersion: 1,
    domainRef,
    runRef,
    taskInstanceRef: fixture.taskInstanceRef,
    taskFamilyRef: fixture.taskFamilyRef,
    configHash: selectedArtifact.configHash,
    promptHash: selectedArtifact.promptHash,
    outcome: 'success',
    accepted: true,
    failure: null,
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

function input(): OfflineEvidenceResolverInputV1 {
  const baseArtifact = artifact('a')
  const variantArtifact = artifact('e')
  const baseRuns = TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures.map((fixture, index) =>
    run(fixture.baseDomainRef, ref(String(index + 1)), index, baseArtifact))
  const variantRuns = TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures.map((fixture, index) =>
    run(fixture.variantDomainRef, ref(String(index + 3)), index, variantArtifact))
  return {
    schemaVersion: 1,
    corpusManifest: structuredClone(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST) as OfflineEvidenceResolverInputV1['corpusManifest'],
    baseArtifact,
    variantArtifact,
    baseRuns,
    variantRuns,
  }
}

describe('authoritative offline evidence resolver', () => {
  it('derives ordered complete arms, pairs, metrics, comparisons, and result', () => {
    const evidence = resolveOfflineEvidence(input())

    expect(evidence.policy.policyDigest).toBe(TEMPLATE_OFFLINE_V1_POLICY_DIGEST)
    expect(evidence.baseArm.runs.map(run => run.fixtureId)).toEqual([
      'cross-domain-summary',
      'same-domain-edit',
    ])
    expect(evidence.baseArm).toMatchObject({
      fixtureRuns: 2,
      resolvedRuns: 2,
      completeRuns: 2,
      incompleteRuns: 0,
      excludedRuns: 0,
    })
    expect(evidence.variantArm.completeRuns).toBe(2)
    expect(evidence.pairs.map(pair => pair.pairingKey)).toEqual([
      'cross-domain-summary',
      'same-domain-edit',
    ])
    expect(evidence.baseArm.metrics[0]).toMatchObject({ value: 1, numerator: 2, denominator: 2 })
    expect(evidence.comparisons.every(comparison => comparison.result === 'pass')).toBe(true)
    expect(evidence.result).toBe('passed')
    expect(evaluateGovernanceEvidence(evidence)).toEqual(evidence)
  })

  it('rejects a self-consistent substituted manifest as non-authoritative', () => {
    const candidate = input()
    const fixtures = structuredClone(candidate.corpusManifest.fixtures) as Array<OfflineEvidenceResolverInputV1['corpusManifest']['fixtures'][number]>
    fixtures[0]!.variantDomainRef = ref('0')
    const body = {
      schemaVersion: 1 as const,
      corpusId: 'template-offline-v1-corpus' as const,
      corpusRevision: '1' as const,
      fixtures,
    }
    candidate.corpusManifest = { ...body, corpusManifestDigest: sha256Canonical(body) }
    const substitutedRun = candidate.variantRuns[0]!
    substitutedRun.ref.domainRef = ref('0')
    substitutedRun.observations.forEach(observation => { observation.domainRef = ref('0') })
    substitutedRun.seal!.domainRef = ref('0')
    substitutedRun.annotation!.domainRef = ref('0')

    expect(() => resolveOfflineEvidence(candidate)).toThrow('governance corpus manifest not authoritative')
  })

  it('classifies admitted missing snapshots as incomplete without inventing pairs', () => {
    const candidate = input()
    candidate.baseRuns = candidate.baseRuns.slice(0, 1)
    candidate.variantRuns = candidate.variantRuns.slice(0, 1)

    const evidence = resolveOfflineEvidence(candidate)
    expect(evidence.baseArm).toMatchObject({ resolvedRuns: 1, completeRuns: 1, incompleteRuns: 1 })
    expect(evidence.variantArm).toMatchObject({ resolvedRuns: 1, completeRuns: 1, incompleteRuns: 1 })
    expect(evidence.pairs).toHaveLength(1)
    expect(evidence.result).toBe('incomplete')
  })
})
