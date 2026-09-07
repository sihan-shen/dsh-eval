import type {
  CandidateV1,
  LessonV1,
  ObservationV1,
  PatternV1,
  RunAnnotationV1,
  RunSealV1,
} from '@ds-plugins/dsh-telemetry/contracts'
import { describe, expect, it } from 'vitest'
import {
  sha256Canonical,
  validateArmMetricObservationV1,
  validateArtifactRefV1,
  validateCandidateSupportV1,
  validateCorpusManifestV1,
  validateEvaluationArmV1,
  validateEvaluationEvidenceV1,
  validateEvaluationPairV1,
  validateEvaluationRunRefV1,
  validateGovernanceEntryV1,
  validateGovernanceLedgerV1,
  validateGovernanceProposalV1,
  validateOfflineEvidenceResolverInputV1,
  validateTemplateArtifactV1,
} from '../../src/governance/index.js'
import type {
  CandidateSupportV1,
  CorpusFixtureV1,
  CorpusManifestV1,
  EvaluationArmV1,
  EvaluationEvidenceV1,
  EvaluationPairV1,
  EvaluationRunRefV1,
  GovernanceEntryV1,
  GovernanceLedgerV1,
  GovernanceProposalV1,
  OfflineEvidenceResolverInputV1,
  TemplateArtifactV1,
} from '../../src/governance/index.js'

const ref = (digit: string): string => digit.repeat(64)

function artifact(digit = 'a'): TemplateArtifactV1 {
  const body = {
    schemaVersion: 1 as const,
    ref: { schemaVersion: 1 as const, surface: 'template' as const, version: '1.0.0', digest: ref(digit) },
    configHash: ref('b'),
    promptHash: ref(digit === 'a' ? 'c' : 'd'),
  }
  return { ...body, bindingDigest: sha256Canonical(body) }
}

function corpusFixture(id = 'fixture-1', pairingKey = 'pair-1'): CorpusFixtureV1 {
  return {
    fixtureId: id,
    fixtureRevision: '1',
    pairingKey,
    baseDomainRef: ref('1'),
    variantDomainRef: ref('2'),
    taskFamilyRef: ref('3'),
    taskInstanceRef: ref('4'),
    fixtureInputDigest: ref('5'),
  }
}

function manifest(fixtures = [corpusFixture()]): CorpusManifestV1 {
  const body = {
    schemaVersion: 1 as const,
    corpusId: 'template-offline-v1-corpus' as const,
    corpusRevision: '1' as const,
    fixtures,
  }
  return { ...body, corpusManifestDigest: sha256Canonical(body) }
}

function runRef(overrides: Partial<EvaluationRunRefV1> = {}): EvaluationRunRefV1 {
  return {
    domainRef: ref('1'),
    runRef: ref('6'),
    fixtureId: 'fixture-1',
    fixtureRevision: '1',
    pairingKey: 'pair-1',
    ...overrides,
  }
}

function unavailableMetrics(): EvaluationArmV1['metrics'] {
  return ['task_success_rate', 'accepted_result_rate', 'verification_cost'].map(name => ({
    name,
    value: null,
    numerator: 0,
    denominator: 0,
    observedRuns: 0,
    eligibleRuns: 0,
    basis: 'unavailable' as const,
  }))
}

function emptyArm(armArtifact = artifact()): EvaluationArmV1 {
  return {
    artifact: armArtifact,
    corpusRevision: '1',
    runs: [],
    fixtureRuns: 1,
    resolvedRuns: 0,
    completeRuns: 0,
    incompleteRuns: 1,
    excludedRuns: 0,
    metrics: unavailableMetrics(),
  }
}

function resolverInput(): OfflineEvidenceResolverInputV1 {
  return {
    schemaVersion: 1,
    corpusManifest: manifest(),
    baseArtifact: artifact(),
    variantArtifact: artifact('e'),
    baseRuns: [],
    variantRuns: [],
  }
}

function evaluation(): EvaluationEvidenceV1 {
  const resolver = resolverInput()
  return {
    schemaVersion: 1,
    policy: { policyId: 'template-offline-v1', policyRevision: 1, policyDigest: ref('f') },
    corpusId: resolver.corpusManifest.corpusId,
    corpusRevision: resolver.corpusManifest.corpusRevision,
    corpusManifestDigest: resolver.corpusManifest.corpusManifestDigest,
    resolverInput: resolver,
    baseArm: emptyArm(resolver.baseArtifact),
    variantArm: emptyArm(resolver.variantArtifact),
    pairs: [],
    comparisons: ['task_success_rate', 'accepted_result_rate', 'verification_cost'].map(name => ({
      name,
      baseValue: null,
      variantValue: null,
      delta: null,
      result: 'unavailable' as const,
    })),
    result: 'incomplete',
  }
}

function observation(domainRef: string, run: string): ObservationV1 {
  return {
    schemaVersion: 1,
    domainRef,
    runRef: run,
    sessionRef: ref('7'),
    seq: 1,
    kind: 'budget-rejected',
    observedAtMs: 0,
    facts: { status: 'budget-rejected' },
  }
}

function seal(domainRef: string, run: string): RunSealV1 {
  return {
    schemaVersion: 1,
    kind: 'run-seal',
    domainRef,
    runRef: run,
    observationCount: 1,
    lostCount: 0,
    complete: true,
  }
}

function annotation(domainRef: string, run: string, task: string): RunAnnotationV1 {
  const evidence = [{ runRef: run, seq: 1 }]
  return {
    schemaVersion: 1,
    domainRef,
    runRef: run,
    taskInstanceRef: task,
    taskFamilyRef: ref('3'),
    configHash: ref('b'),
    promptHash: ref('c'),
    outcome: 'failure',
    accepted: false,
    failure: { category: 'budget_exhaustion', evidence, attribution: 'observed' },
    evidence,
  }
}

function support(): { support: CandidateSupportV1, candidate: CandidateV1 } {
  const domainRef = ref('1')
  const runRefs = [ref('6'), ref('8'), ref('9')]
  const evidence = runRefs.map(run => ({ runRef: run, seq: 1 }))
  const patternBody: Omit<PatternV1, 'id'> = {
    schemaVersion: 1,
    category: 'budget_exhaustion',
    domainRef,
    taskFamilyRef: ref('3'),
    configHash: ref('b'),
    promptHash: ref('c'),
    runRefs,
    taskInstanceRefs: [ref('4'), ref('a')],
    evidence,
  }
  const pattern: PatternV1 = { ...patternBody, id: sha256Canonical(patternBody) }
  const lessonBody: Omit<LessonV1, 'id'> = {
    schemaVersion: 1,
    revision: 1,
    pattern,
    rule: 'review-failure-evidence',
  }
  const lesson: LessonV1 = { ...lessonBody, id: sha256Canonical(lessonBody) }
  const candidateBody: Omit<CandidateV1, 'id'> = {
    schemaVersion: 1,
    revision: 1,
    kind: 'prompt',
    status: 'proposed',
    lessonId: lesson.id,
    baseConfigHash: pattern.configHash,
    basePromptHash: pattern.promptHash,
    hypothesis: lesson.rule,
    evidence,
    evaluationRequired: true,
    autoPromote: false,
  }
  return {
    candidate: { ...candidateBody, id: sha256Canonical(candidateBody) },
    support: {
      schemaVersion: 1,
      lesson,
      evidence: evidence.map(item => ({ domainRef, ...item })),
      runs: runRefs.map((run, index) => ({
        domainRef,
        runRef: run,
        observations: [observation(domainRef, run)],
        seal: seal(domainRef, run),
        annotation: annotation(domainRef, run, index === 2 ? ref('a') : ref('4')),
      })),
    },
  }
}

function proposal(): GovernanceProposalV1 {
  const candidateSupport = support()
  return {
    schemaVersion: 1,
    proposalId: 'proposal-1',
    candidate: candidateSupport.candidate,
    candidateSupport: candidateSupport.support,
    bundleVersion: 'bundle-1',
    policyGeneration: 'generation-1',
    surface: 'template',
    base: artifact(),
    variant: artifact('e'),
    evaluation: evaluation(),
    status: 'proposed',
    approval: null,
    rejection: null,
    promotion: null,
    rollback: null,
    rollbackTarget: null,
  }
}

function ledger(): GovernanceLedgerV1 {
  const initialActive = { template: artifact() }
  const proposalSnapshot = proposal()
  const seedDigest = sha256Canonical({ schemaVersion: 1, initialActive })
  const entryBody = {
    schemaVersion: 1 as const,
    seedDigest,
    sequence: 1,
    predecessorDigest: null,
    transition: 'propose' as const,
    decision: null,
    proposal: proposalSnapshot,
  }
  const entry: GovernanceEntryV1 = {
    schemaVersion: 1,
    sequence: 1,
    entryId: sha256Canonical(entryBody),
    predecessorDigest: null,
    transition: 'propose',
    decision: null,
    proposal: proposalSnapshot,
  }
  return { schemaVersion: 1, initialActive, entries: [entry], headDigest: entry.entryId }
}

describe('governance contract validators', () => {
  it('accepts and detaches every contract layer', () => {
    const input = ledger()
    const validated = validateGovernanceLedgerV1(input)
    const independentlyValidated = validateGovernanceLedgerV1(input)

    expect(validated).toEqual(input)
    expect(validated).not.toBe(input)
    expect(validated.entries[0].proposal).not.toBe(input.entries[0].proposal)

    validated.entries[0].proposal.proposalId = 'changed-output'
    expect(independentlyValidated.entries[0].proposal.proposalId).toBe('proposal-1')

    input.entries[0].proposal.proposalId = 'mutated'
    input.initialActive.template.ref.version = '2.0.0'
    expect(independentlyValidated.entries[0].proposal.proposalId).toBe('proposal-1')
    expect(independentlyValidated.initialActive.template.ref.version).toBe('1.0.0')
  })

  it('exports focused validators for leaf and container contracts', () => {
    const resolver = resolverInput()
    const evidence = evaluation()
    const p = proposal()
    const l = ledger()

    expect(validateArtifactRefV1(artifact().ref)).toEqual(artifact().ref)
    expect(validateTemplateArtifactV1(artifact())).toEqual(artifact())
    expect(validateCorpusManifestV1(manifest())).toEqual(manifest())
    expect(validateEvaluationRunRefV1(runRef())).toEqual(runRef())
    expect(validateArmMetricObservationV1({
      name: 'task_success_rate',
      value: 1 / 3,
      numerator: 1,
      denominator: 3,
      observedRuns: 1,
      eligibleRuns: 3,
      basis: 'estimated',
    })).toEqual({
      name: 'task_success_rate',
      value: 1 / 3,
      numerator: 1,
      denominator: 3,
      observedRuns: 1,
      eligibleRuns: 3,
      basis: 'estimated',
    })
    expect(validateEvaluationArmV1(emptyArm())).toEqual(emptyArm())
    expect(validateOfflineEvidenceResolverInputV1(resolver)).toEqual(resolver)
    expect(validateEvaluationEvidenceV1(evidence)).toEqual(evidence)
    expect(validateCandidateSupportV1(p.candidateSupport)).toEqual(p.candidateSupport)
    expect(validateGovernanceProposalV1(p)).toEqual(p)
    expect(validateGovernanceEntryV1(l.entries[0])).toEqual(l.entries[0])
  })

  it('rejects unknown keys, wrong literals, malformed hashes, and invalid semver', () => {
    expect(() => validateArtifactRefV1({ ...artifact().ref, extra: true })).toThrow('governance validation artifactRef keys')
    expect(() => validateArtifactRefV1({ ...artifact().ref, schemaVersion: 2 })).toThrow('artifactRef.schemaVersion literal')
    expect(() => validateArtifactRefV1({ ...artifact().ref, surface: 'templates' })).toThrow('artifactRef.surface enum')
    expect(() => validateArtifactRefV1({ ...artifact().ref, digest: ref('A') })).toThrow('artifactRef.digest hash')
    expect(() => validateArtifactRefV1({ ...artifact().ref, version: '01.0.0' })).toThrow('artifactRef.version semver')
  })

  it('rejects inconsistent artifact and manifest digests', () => {
    expect(() => validateTemplateArtifactV1({ ...artifact(), bindingDigest: ref('0') })).toThrow('templateArtifact.bindingDigest derived')
    expect(() => validateCorpusManifestV1({ ...manifest(), corpusManifestDigest: ref('0') })).toThrow('corpusManifest.corpusManifestDigest derived')
  })

  it('rejects unordered or duplicate tuple and run identities without sorting', () => {
    const fixtures = [corpusFixture('fixture-2', 'pair-2'), corpusFixture('fixture-1', 'pair-1')]
    expect(() => validateCorpusManifestV1(manifest(fixtures))).toThrow('corpusManifest.fixtures order')

    const duplicateRuns = [runRef(), runRef({ fixtureId: 'fixture-2', pairingKey: 'pair-2' })]
    expect(() => validateEvaluationArmV1({ ...emptyArm(), runs: duplicateRuns, resolvedRuns: 2 })).toThrow('evaluationArm.runs unique-run')
  })

  it('rejects array bounds before accepting elements', () => {
    expect(() => validateCorpusManifestV1(manifest([]))).toThrow('corpusManifest.fixtures length')
    expect(() => validateCorpusManifestV1(manifest(Array.from({ length: 257 }, () => null) as never))).toThrow('corpusManifest.fixtures length')
    expect(() => validateCandidateSupportV1({ ...support().support, runs: [null, null] } as never)).toThrow('candidateSupport.runs length')
    expect(() => validateCandidateSupportV1({ ...support().support, runs: Array(4_097).fill(null) } as never)).toThrow('candidateSupport.runs length')
  })

  it('rejects malformed ordering and uniqueness in candidate support', () => {
    const valid = support().support
    expect(() => validateCandidateSupportV1({ ...valid, evidence: [...valid.evidence].reverse() })).toThrow('candidateSupport.evidence order')
    expect(() => validateCandidateSupportV1({ ...valid, runs: [valid.runs[1], valid.runs[0], valid.runs[2]] })).toThrow('candidateSupport.runs order')
    expect(() => validateCandidateSupportV1({ ...valid, runs: [valid.runs[0], valid.runs[0], valid.runs[2]] })).toThrow(/candidateSupport\.runs (order|unique-run)/u)
    expect(() => validateCandidateSupportV1({
      ...valid,
      runs: valid.runs.map((run, index) => index === 0
        ? { ...run, observations: [run.observations[0], { ...run.observations[0], seq: 1 }] }
        : run),
    })).toThrow('candidateSupport.runs[0].observations order')
  })

  it('rejects inconsistent arm counts, metric values, pair bindings, and evidence identity', () => {
    expect(() => validateEvaluationArmV1({ ...emptyArm(), incompleteRuns: 0 })).toThrow('evaluationArm.incompleteRuns derived')
    const metricArm = emptyArm()
    metricArm.metrics[0] = { ...metricArm.metrics[0], value: 0, denominator: 0 }
    expect(() => validateEvaluationArmV1(metricArm)).toThrow('evaluationArm.metrics[0] unavailable-shape')

    const pair: EvaluationPairV1 = {
      fixtureId: 'fixture-1', fixtureRevision: '1', pairingKey: 'pair-1',
      baseRun: runRef(), variantRun: runRef({ domainRef: ref('2'), runRef: ref('7') }),
    }
    expect(validateEvaluationPairV1(pair)).toEqual(pair)
    expect(() => validateEvaluationPairV1({ ...pair, pairingKey: 'pair-2' })).toThrow('evaluationPair.baseRun tuple')

    const evidence = evaluation()
    expect(() => validateEvaluationEvidenceV1({ ...evidence, corpusRevision: '2' })).toThrow('evaluationEvidence.corpusRevision derived')
    expect(() => validateEvaluationEvidenceV1({ ...evidence, result: 'passed' })).toThrow('evaluationEvidence.result derived')
  })

  it('rejects proposal surface, candidate, and decision-state inconsistencies', () => {
    const valid = proposal()
    expect(() => validateGovernanceProposalV1({ ...valid, surface: 'routing' })).toThrow('governanceProposal.surface literal')
    expect(() => validateGovernanceProposalV1({ ...valid, candidate: { ...valid.candidate, kind: 'routing' } })).toThrow('governanceProposal.candidate.kind literal')
    expect(() => validateGovernanceProposalV1({
      ...valid,
      status: 'approved',
      approval: null,
    })).toThrow('governanceProposal.approval state')
  })

  it('rejects ledger sequence, predecessor, entry digest, and head inconsistencies', () => {
    const valid = ledger()
    expect(() => validateGovernanceLedgerV1({ ...valid, entries: [{ ...valid.entries[0], sequence: 2 }] })).toThrow('governanceLedger.entries[0].sequence derived')
    expect(() => validateGovernanceLedgerV1({ ...valid, entries: [{ ...valid.entries[0], predecessorDigest: ref('0') }] })).toThrow('governanceLedger.entries[0].predecessorDigest derived')
    expect(() => validateGovernanceLedgerV1({ ...valid, entries: [{ ...valid.entries[0], entryId: ref('0') }] })).toThrow('governanceLedger.entries[0].entryId derived')
    expect(() => validateGovernanceLedgerV1({ ...valid, headDigest: ref('0') })).toThrow('governanceLedger.headDigest derived')
  })

  it('treats below-policy metric coverage as unavailable for comparison', () => {
    const valid = evaluation()
    const corpus = manifest([corpusFixture(), corpusFixture('fixture-2', 'pair-2')])
    const baseRefs = [
      runRef(),
      runRef({ runRef: ref('7'), fixtureId: 'fixture-2', pairingKey: 'pair-2' }),
    ]
    const variantRefs = [
      runRef({ domainRef: ref('2'), runRef: ref('8') }),
      runRef({ domainRef: ref('2'), runRef: ref('9'), fixtureId: 'fixture-2', pairingKey: 'pair-2' }),
    ]
    const baseRuns = [
      {
        ref: baseRefs[0]!,
        observations: [observation(ref('1'), ref('6'))],
        seal: seal(ref('1'), ref('6')),
        annotation: { ...annotation(ref('1'), ref('6'), ref('4')), outcome: 'success' as const, accepted: true, failure: null },
      },
      {
        ref: baseRefs[1]!,
        observations: [observation(ref('1'), ref('7'))],
        seal: seal(ref('1'), ref('7')),
        annotation: {
          ...annotation(ref('1'), ref('7'), ref('4')),
          outcome: 'unknown' as const,
          accepted: null,
          failure: null,
        },
      },
    ]
    const variantRuns = variantRefs.map((run, index) => ({
      ref: run,
      observations: [observation(run.domainRef, run.runRef)],
      seal: seal(run.domainRef, run.runRef),
      annotation: {
        ...annotation(run.domainRef, run.runRef, ref('4')),
        promptHash: ref('d'),
        outcome: 'success' as const,
        accepted: true,
        failure: null,
      },
    }))
    valid.resolverInput.corpusManifest = corpus
    valid.resolverInput.baseRuns = baseRuns
    valid.resolverInput.variantRuns = variantRuns
    valid.baseArm = {
      ...emptyArm(),
      runs: baseRefs,
      fixtureRuns: 2,
      resolvedRuns: 2,
      completeRuns: 2,
      incompleteRuns: 0,
      metrics: [
        { name: 'task_success_rate', value: 1, numerator: 1, denominator: 1, observedRuns: 1, eligibleRuns: 2, basis: 'observed' },
        { name: 'accepted_result_rate', value: 1, numerator: 1, denominator: 1, observedRuns: 1, eligibleRuns: 2, basis: 'observed' },
        { name: 'verification_cost', value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 2, basis: 'unavailable' },
      ],
    }
    valid.variantArm = {
      ...emptyArm(artifact('e')),
      runs: variantRefs,
      fixtureRuns: 2,
      resolvedRuns: 2,
      completeRuns: 2,
      incompleteRuns: 0,
      metrics: [
        { name: 'task_success_rate', value: 1, numerator: 2, denominator: 2, observedRuns: 2, eligibleRuns: 2, basis: 'observed' },
        { name: 'accepted_result_rate', value: 1, numerator: 2, denominator: 2, observedRuns: 2, eligibleRuns: 2, basis: 'observed' },
        { name: 'verification_cost', value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 2, basis: 'unavailable' },
      ],
    }
    valid.pairs = corpus.fixtures.map((fixture, index) => ({
      fixtureId: fixture.fixtureId,
      fixtureRevision: fixture.fixtureRevision,
      pairingKey: fixture.pairingKey,
      baseRun: baseRefs[index]!,
      variantRun: variantRefs[index]!,
    }))
    valid.comparisons = [
      { name: 'task_success_rate', baseValue: null, variantValue: null, delta: null, result: 'unavailable' as const },
      { name: 'accepted_result_rate', baseValue: null, variantValue: null, delta: null, result: 'unavailable' as const },
      { name: 'verification_cost', baseValue: null, variantValue: null, delta: null, result: 'unavailable' as const },
    ]
    valid.corpusId = corpus.corpusId
    valid.corpusRevision = corpus.corpusRevision
    valid.corpusManifestDigest = corpus.corpusManifestDigest
    valid.result = 'incomplete'

    expect(() => validateEvaluationEvidenceV1(valid)).not.toThrow()
  })

  it('rejects non-JSON object tricks without invoking getters or toJSON', () => {
    let calls = 0
    const accessor = { ...artifact().ref } as Record<string, unknown>
    Object.defineProperty(accessor, 'digest', { enumerable: true, get: () => { calls += 1; return ref('a') } })
    expect(() => validateArtifactRefV1(accessor)).toThrow('accessor')
    expect(calls).toBe(0)

    const withToJson = { ...artifact().ref, toJSON: () => { calls += 1; return {} } }
    expect(() => validateArtifactRefV1(withToJson)).toThrow('json-value')
    expect(calls).toBe(0)

    const cases: unknown[] = [
      Object.assign(Object.create({}), artifact().ref),
      Object.defineProperty({ ...artifact().ref }, 'hidden', { value: true, enumerable: false }),
      Object.assign({ ...artifact().ref }, { [Symbol('secret')]: true }),
      { ...artifact().ref, digest: undefined },
      { ...artifact().ref, digest: () => ref('a') },
      { ...artifact().ref, digest: 1n },
      { ...artifact().ref, digest: Number.NaN },
      { ...artifact().ref, digest: -0 },
    ]
    const cyclic = { ...artifact().ref, nested: null as unknown }
    cyclic.nested = cyclic
    cases.push(cyclic)
    for (const value of cases) expect(() => validateArtifactRefV1(value)).toThrow()

    const sparse = [runRef(), , runRef()]
    const named = [runRef()]
    Object.assign(named, { named: true })
    expect(() => validateEvaluationArmV1({ ...emptyArm(), runs: sparse })).toThrow('sparse')
    expect(() => validateEvaluationArmV1({ ...emptyArm(), runs: named })).toThrow('array-property')
  })

  it('keeps validation errors bounded and excludes caller-controlled keys and values', () => {
    const privateValue = 'PRIVATE_PAYLOAD_SHOULD_NOT_APPEAR'
    try {
      validateArtifactRefV1({ ...artifact().ref, [privateValue]: privateValue })
      throw new Error('expected validation failure')
    } catch (error) {
      const message = String((error as Error).message)
      expect(message).toBe('governance validation artifactRef keys')
      expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(512)
      expect(message).not.toContain(privateValue)
    }
  })
})
