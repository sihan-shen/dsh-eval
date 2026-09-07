import {
  FAILURE_CLASSES,
  type CandidateV1,
  type FailureClassV1,
  type LessonV1,
  type ObservationV1,
  type PatternV1,
  type RunAnnotationV1,
  type RunSealV1,
} from '@ds-plugins/dsh-telemetry/contracts'
import { describe, expect, it } from 'vitest'
import {
  canonicalGovernanceJson,
  resolveCandidateSupport,
  sha256Canonical,
} from '../../src/governance/index.js'
import type {
  CandidateSupportRunV1,
  CandidateSupportV1,
  TemplateArtifactV1,
} from '../../src/governance/index.js'

const hash = (value: number): string => value.toString(16).padStart(64, '0')

const DOMAIN = hash(201)
const FAMILY = hash(202)
const CONFIG = hash(203)
const PROMPT = hash(204)
const TASK_A = hash(301)
const TASK_B = hash(302)

const RULES: Record<FailureClassV1, LessonV1['rule']> = {
  context_loss: 'review-context-boundary',
  insufficient_context: 'review-context-boundary',
  context_bloat: 'review-context-boundary',
  bad_reasoning: 'review-failure-evidence',
  wrong_model: 'review-route-fit',
  prompt_incompatibility: 'review-route-fit',
  tool_misuse: 'review-failure-evidence',
  premature_edit: 'review-failure-evidence',
  implementation_error: 'review-failure-evidence',
  verification_gap: 'review-verification-scope',
  scope_creep: 'review-failure-evidence',
  bad_handoff: 'review-failure-evidence',
  bad_routing: 'review-route-fit',
  provider_failure: 'review-failure-evidence',
  budget_exhaustion: 'review-failure-evidence',
}

function compareEvidence(
  left: { runRef: string, seq: number },
  right: { runRef: string, seq: number },
): number {
  if (left.runRef < right.runRef) return -1
  if (left.runRef > right.runRef) return 1
  return left.seq - right.seq
}

function artifact(configHash = CONFIG, promptHash = PROMPT): TemplateArtifactV1 {
  const body = {
    schemaVersion: 1 as const,
    ref: {
      schemaVersion: 1 as const,
      surface: 'template' as const,
      version: '1.0.0',
      digest: hash(401),
    },
    configHash,
    promptHash,
  }
  return { ...body, bindingDigest: sha256Canonical(body) }
}

function observation(
  runRef: string,
  seq: number,
  kind: ObservationV1['kind'] = 'run-started',
  domainRef = DOMAIN,
): ObservationV1 {
  const facts: ObservationV1['facts'] = kind === 'budget-rejected'
    ? { status: 'budget-rejected' }
    : kind === 'verification-finished'
      ? { status: 'failed' }
      : { routeRef: hash(500), scope: 'root' }
  return {
    schemaVersion: 1,
    domainRef,
    runRef,
    sessionRef: hash(501),
    seq,
    kind,
    observedAtMs: seq,
    facts,
  }
}

function supportRun(options: {
  run: number
  task?: string
  category?: FailureClassV1
  attribution?: 'observed' | 'reviewed'
  kinds?: ObservationV1['kind'][]
  failureSeqs?: number[]
  generalSeqs?: number[]
  domainRef?: string
  taskFamilyRef?: string
  configHash?: string
  promptHash?: string
}): CandidateSupportRunV1 {
  const runRef = hash(options.run)
  const domainRef = options.domainRef ?? DOMAIN
  const kinds = options.kinds ?? ['run-started']
  const observations = kinds.map((kind, index) => observation(runRef, index + 1, kind, domainRef))
  const evidence = (options.generalSeqs ?? [1]).map(seq => ({ runRef, seq }))
  const failureEvidence = (options.failureSeqs ?? [1]).map(seq => ({ runRef, seq }))
  const annotation: RunAnnotationV1 = {
    schemaVersion: 1,
    domainRef,
    runRef,
    taskInstanceRef: options.task ?? TASK_A,
    taskFamilyRef: options.taskFamilyRef ?? FAMILY,
    configHash: options.configHash ?? CONFIG,
    promptHash: options.promptHash ?? PROMPT,
    outcome: 'failure',
    accepted: false,
    failure: {
      category: options.category ?? 'context_loss',
      evidence: failureEvidence,
      attribution: options.attribution ?? 'reviewed',
    },
    evidence,
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
  return { domainRef, runRef, observations, seal, annotation }
}

type SnapshotOptions = {
  category?: FailureClassV1
  runRefs?: string[]
  taskInstanceRefs?: string[]
  evidence?: Array<{ runRef: string, seq: number }>
}

function snapshot(
  inputRuns: CandidateSupportRunV1[],
  options: SnapshotOptions = {},
): { candidate: CandidateV1, support: CandidateSupportV1, baseArtifact: TemplateArtifactV1 } {
  const runs = [...inputRuns].sort((left, right) => {
    if (left.domainRef < right.domainRef) return -1
    if (left.domainRef > right.domainRef) return 1
    return left.runRef < right.runRef ? -1 : left.runRef > right.runRef ? 1 : 0
  })
  const first = runs[0]!
  const firstAnnotation = first.annotation!
  const category = options.category ?? firstAnnotation.failure!.category
  const runRefs = options.runRefs ?? runs.map(run => run.runRef)
  const selected = runRefs.map(runRef => runs.find(run => run.runRef === runRef)!)
  const taskInstanceRefs = options.taskInstanceRefs
    ?? [...new Set(selected.map(run => run.annotation!.taskInstanceRef))].sort()
  const evidence = options.evidence
    ?? selected.map(run => ({ ...run.annotation!.failure!.evidence[0]! })).sort(compareEvidence)
  const patternBody: Omit<PatternV1, 'id'> = {
    schemaVersion: 1,
    category,
    domainRef: first.domainRef,
    taskFamilyRef: firstAnnotation.taskFamilyRef,
    configHash: firstAnnotation.configHash,
    promptHash: firstAnnotation.promptHash,
    runRefs,
    taskInstanceRefs,
    evidence,
  }
  const pattern: PatternV1 = { ...patternBody, id: sha256Canonical(patternBody) }
  const rule = RULES[category]
  const lessonBody: Omit<LessonV1, 'id'> = {
    schemaVersion: 1,
    revision: 1,
    pattern,
    rule,
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
    hypothesis: rule,
    evidence,
    evaluationRequired: true,
    autoPromote: false,
  }
  return {
    candidate: { ...candidateBody, id: sha256Canonical(candidateBody) },
    support: {
      schemaVersion: 1,
      lesson,
      evidence: evidence.map(item => ({ domainRef: pattern.domainRef, ...item })),
      runs,
    },
    baseArtifact: artifact(pattern.configHash, pattern.promptHash),
  }
}

function threeRuns(
  category: FailureClassV1 = 'context_loss',
  attribution: 'observed' | 'reviewed' = 'reviewed',
): CandidateSupportRunV1[] {
  return [
    supportRun({ run: 1, category, attribution }),
    supportRun({ run: 2, category, attribution }),
    supportRun({ run: 3, task: TASK_B, category, attribution }),
  ]
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

describe('resolveCandidateSupport', () => {
  it.each(FAILURE_CLASSES)('replays reviewed %s support with the fixed rule and exact hash bodies', category => {
    const fixture = snapshot(threeRuns(category))

    const resolved = resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)

    expect(resolved).toEqual(fixture.support)
    expect(resolved).not.toBe(fixture.support)
    expect(resolved.lesson).not.toBe(fixture.support.lesson)
    expect(resolved.lesson.pattern.category).toBe(category)
    expect(resolved.lesson.rule).toBe(RULES[category])
    expect(resolved.lesson.pattern.id).toBe(sha256Canonical({
      schemaVersion: 1,
      category,
      domainRef: DOMAIN,
      taskFamilyRef: FAMILY,
      configHash: CONFIG,
      promptHash: PROMPT,
      runRefs: [hash(1), hash(2), hash(3)],
      taskInstanceRefs: [TASK_A, TASK_B],
      evidence: [1, 2, 3].map(run => ({ runRef: hash(run), seq: 1 })),
    }))
    expect(resolved.runs.every(run => run.observations.every(item => item.kind !== 'budget-rejected'))).toBe(true)
  })

  it('accepts observed budget exhaustion only through referenced budget-rejected observations', () => {
    const runs = [1, 2, 3].map(run => supportRun({
      run,
      task: run === 3 ? TASK_B : TASK_A,
      category: 'budget_exhaustion',
      attribution: 'observed',
      kinds: ['verification-finished', 'budget-rejected'],
      failureSeqs: [2, 1, 2],
      generalSeqs: [1],
    }))
    const evidence = runs.map(run => ({ runRef: run.runRef, seq: 2 }))
    const fixture = snapshot(runs, { evidence })

    const resolved = resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)

    expect(resolved.lesson.pattern.evidence).toEqual(evidence)
    expect(resolved.runs[0]!.annotation!.failure!.evidence).toEqual([
      { runRef: hash(1), seq: 2 },
      { runRef: hash(1), seq: 1 },
      { runRef: hash(1), seq: 2 },
    ])
  })

  it('pins the exact pattern, lesson, and prompt-candidate hash preimages', () => {
    const fixture = snapshot(threeRuns('context_loss'))

    resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)

    expect(fixture.support.lesson.pattern.id).toBe('6ced5c083342e196439062bb17b8fb25b460d2ad2aac96cd63185ffb09dc37c2')
    expect(fixture.support.lesson.id).toBe('58a541600b5c2bb53545f415f349d69a04a487ca9a0d61e00e12729f073009e5')
    expect(fixture.candidate.id).toBe('eb0f6e96e117787f4258a7013e839f8d6a6462dfb3feb0239482967fb81f4d61')
  })

  it('selects the first 31 runs plus the final alternate task from a 40-run pool', () => {
    const runs = Array.from({ length: 40 }, (_, index) => supportRun({
      run: index + 1,
      task: index === 39 ? TASK_B : TASK_A,
    }))
    const selectedRunRefs = [...Array.from({ length: 31 }, (_, index) => hash(index + 1)), hash(40)]
    const evidence = selectedRunRefs.map(runRef => ({ runRef, seq: 1 }))
    const fixture = snapshot(runs, { runRefs: selectedRunRefs, evidence })

    const resolved = resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)

    expect(resolved.runs).toHaveLength(40)
    expect(resolved.lesson.pattern.runRefs).toEqual(selectedRunRefs)
    expect(resolved.lesson.pattern.taskInstanceRefs).toEqual([TASK_A, TASK_B])
    expect(resolved.lesson.pattern.evidence).toEqual(evidence)
  })

  it('seeds every selected run then fills from the sorted evidence union to 32', () => {
    const reversed = Array.from({ length: 12 }, (_, index) => 12 - index)
    const runs = [1, 2, 3].map(run => supportRun({
      run,
      task: run === 3 ? TASK_B : TASK_A,
      kinds: Array.from({ length: 12 }, () => 'run-started'),
      failureSeqs: [...reversed, 6],
    }))
    const evidence = [
      ...Array.from({ length: 12 }, (_, index) => ({ runRef: hash(1), seq: index + 1 })),
      ...Array.from({ length: 12 }, (_, index) => ({ runRef: hash(2), seq: index + 1 })),
      ...Array.from({ length: 8 }, (_, index) => ({ runRef: hash(3), seq: index + 1 })),
    ]
    const fixture = snapshot(runs, { evidence })

    const resolved = resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)

    expect(resolved.lesson.pattern.evidence).toEqual(evidence)
    expect(resolved.runs[0]!.annotation!.failure!.evidence.map(item => item.seq)).toEqual([...reversed, 6])
  })

  it.each(['success', 'unknown'] as const)('rejects a %s pool member instead of dropping it', outcome => {
    const fixture = snapshot(threeRuns())
    const invalid = clone(fixture.support)
    invalid.runs[2]!.annotation = {
      ...invalid.runs[2]!.annotation!,
      outcome,
      failure: null,
    }

    expect(() => resolveCandidateSupport(fixture.candidate, invalid, fixture.baseArtifact)).toThrow()
  })

  it('rejects a failure attached to a non-failure outcome', () => {
    const fixture = snapshot(threeRuns())
    const invalid = clone(fixture.support)
    invalid.runs[2]!.annotation!.outcome = 'success'

    expect(() => resolveCandidateSupport(fixture.candidate, invalid, fixture.baseArtifact)).toThrow()
  })

  it.each(FAILURE_CLASSES.filter(category => category !== 'budget_exhaustion'))(
    'rejects observed attribution for unsupported category %s',
    category => {
      const fixture = snapshot(threeRuns(category))
      const invalid = clone(fixture.support)
      for (const run of invalid.runs) run.annotation!.failure!.attribution = 'observed'

      expect(() => resolveCandidateSupport(fixture.candidate, invalid, fixture.baseArtifact)).toThrow()
    },
  )

  it.each([
    {
      name: 'verification failure only',
      kinds: ['verification-finished'] as ObservationV1['kind'][],
      failureSeqs: [1],
      generalSeqs: [1],
    },
    {
      name: 'an unreferenced budget rejection',
      kinds: ['verification-finished', 'budget-rejected'] as ObservationV1['kind'][],
      failureSeqs: [1],
      generalSeqs: [1],
    },
    {
      name: 'a budget rejection present only in general evidence',
      kinds: ['verification-finished', 'budget-rejected'] as ObservationV1['kind'][],
      failureSeqs: [1],
      generalSeqs: [2],
    },
  ])('rejects observed budget exhaustion backed by $name', ({ kinds, failureSeqs, generalSeqs }) => {
    const runs = [1, 2, 3].map(run => supportRun({
      run,
      task: run === 3 ? TASK_B : TASK_A,
      category: 'budget_exhaustion',
      attribution: 'observed',
      kinds,
      failureSeqs,
      generalSeqs,
    }))
    const fixture = snapshot(runs)

    expect(() => resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)).toThrow()
  })

  it.each([
    ['missing annotation', (support: CandidateSupportV1) => { support.runs[2]!.annotation = null }],
    ['missing seal', (support: CandidateSupportV1) => { support.runs[2]!.seal = null }],
    ['incomplete seal', (support: CandidateSupportV1) => {
      support.runs[2]!.seal = { ...support.runs[2]!.seal!, complete: false }
    }],
    ['lossy seal', (support: CandidateSupportV1) => {
      support.runs[2]!.seal = { ...support.runs[2]!.seal!, complete: false, lostCount: 1 }
    }],
    ['incorrect observation count', (support: CandidateSupportV1) => {
      support.runs[2]!.seal!.observationCount = 2
    }],
    ['ordinal gap', (support: CandidateSupportV1) => { support.runs[2]!.observations[0]!.seq = 2 }],
    ['duplicate ordinal', (support: CandidateSupportV1) => {
      const run = support.runs[2]!
      run.observations.push({ ...run.observations[0]! })
      run.seal!.observationCount = 2
    }],
    ['unresolved general evidence', (support: CandidateSupportV1) => {
      support.runs[2]!.annotation!.evidence[0]!.seq = 2
    }],
    ['unresolved failure evidence', (support: CandidateSupportV1) => {
      support.runs[2]!.annotation!.failure!.evidence[0]!.seq = 2
    }],
    ['cross-run general evidence', (support: CandidateSupportV1) => {
      support.runs[2]!.annotation!.evidence[0]!.runRef = hash(2)
    }],
    ['cross-run failure evidence', (support: CandidateSupportV1) => {
      support.runs[2]!.annotation!.failure!.evidence[0]!.runRef = hash(2)
    }],
    ['cross-domain observation', (support: CandidateSupportV1) => {
      support.runs[2]!.observations[0]!.domainRef = hash(999)
    }],
  ] as const)('rejects %s anywhere in the complete supplied pool', (_name, mutate) => {
    const fixture = snapshot(threeRuns())
    const invalid = clone(fixture.support)
    mutate(invalid)

    expect(() => resolveCandidateSupport(fixture.candidate, invalid, fixture.baseArtifact)).toThrow()
  })

  it('rejects duplicate and non-canonically ordered pool runs', () => {
    const fixture = snapshot(threeRuns())
    const duplicate = clone(fixture.support)
    duplicate.runs[2] = clone(duplicate.runs[1]!)
    const reordered = clone(fixture.support)
    reordered.runs.reverse()

    expect(() => resolveCandidateSupport(fixture.candidate, duplicate, fixture.baseArtifact)).toThrow()
    expect(() => resolveCandidateSupport(fixture.candidate, reordered, fixture.baseArtifact)).toThrow()
  })

  it('rejects fewer than three runs and a single task instance', () => {
    const fixture = snapshot(threeRuns())
    const tooFew = clone(fixture.support)
    tooFew.runs = tooFew.runs.slice(0, 2)
    const oneTask = snapshot(threeRuns().map(run => ({
      ...run,
      annotation: { ...run.annotation!, taskInstanceRef: TASK_A },
    })), { taskInstanceRefs: [TASK_A, TASK_B] })

    expect(() => resolveCandidateSupport(fixture.candidate, tooFew, fixture.baseArtifact)).toThrow()
    expect(() => resolveCandidateSupport(oneTask.candidate, oneTask.support, oneTask.baseArtifact)).toThrow()
  })

  it.each([
    ['domain', (run: CandidateSupportRunV1) => {
      const domainRef = hash(700)
      run.domainRef = domainRef
      run.observations = run.observations.map(item => ({ ...item, domainRef }))
      run.seal = { ...run.seal!, domainRef }
      run.annotation = { ...run.annotation!, domainRef }
    }],
    ['task family', (run: CandidateSupportRunV1) => { run.annotation!.taskFamilyRef = hash(701) }],
    ['config hash', (run: CandidateSupportRunV1) => { run.annotation!.configHash = hash(702) }],
    ['prompt hash', (run: CandidateSupportRunV1) => { run.annotation!.promptHash = hash(703) }],
    ['failure category', (run: CandidateSupportRunV1) => { run.annotation!.failure!.category = 'scope_creep' }],
  ] as const)('rejects a pool with mixed %s cohort identity', (_name, mutate) => {
    const fixture = snapshot(threeRuns())
    const invalid = clone(fixture.support)
    mutate(invalid.runs[2]!)

    expect(() => resolveCandidateSupport(fixture.candidate, invalid, fixture.baseArtifact)).toThrow()
  })

  it('rejects an arbitrary diversity-preserving selection from the 40-run pool', () => {
    const runs = Array.from({ length: 40 }, (_, index) => supportRun({
      run: index + 1,
      task: index === 39 ? TASK_B : TASK_A,
    }))
    const arbitrary = [...Array.from({ length: 30 }, (_, index) => hash(index + 1)), hash(32), hash(40)]
    const fixture = snapshot(runs, {
      runRefs: arbitrary,
      evidence: arbitrary.map(runRef => ({ runRef, seq: 1 })),
    })

    expect(() => resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)).toThrow()
  })

  it('rejects the claimed first 32 runs and invented task instances for the diversity pool', () => {
    const runs = Array.from({ length: 40 }, (_, index) => supportRun({
      run: index + 1,
      task: index === 39 ? TASK_B : TASK_A,
    }))
    const first32 = Array.from({ length: 32 }, (_, index) => hash(index + 1))
    const fixture = snapshot(runs, {
      runRefs: first32,
      taskInstanceRefs: [TASK_A, TASK_B],
      evidence: first32.map(runRef => ({ runRef, seq: 1 })),
    })

    expect(() => resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)).toThrow()
  })

  it('rejects omitted eligible evidence even when every selected run remains covered', () => {
    const runs = [1, 2, 3].map(run => supportRun({
      run,
      task: run === 3 ? TASK_B : TASK_A,
      kinds: ['run-started', 'run-started'],
      failureSeqs: [2, 1],
    }))
    const claimed = runs.map(run => ({ runRef: run.runRef, seq: 1 }))
    const fixture = snapshot(runs, { evidence: claimed })

    expect(() => resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)).toThrow()
  })

  it('rejects non-budget evidence selected for observed budget attribution', () => {
    const runs = [1, 2, 3].map(run => supportRun({
      run,
      task: run === 3 ? TASK_B : TASK_A,
      category: 'budget_exhaustion',
      attribution: 'observed',
      kinds: ['verification-finished', 'budget-rejected'],
      failureSeqs: [1, 2],
    }))
    const claimed = runs.map(run => ({ runRef: run.runRef, seq: 1 }))
    const fixture = snapshot(runs, { evidence: claimed })

    expect(() => resolveCandidateSupport(fixture.candidate, fixture.support, fixture.baseArtifact)).toThrow()
  })

  it('rejects candidate, lesson, pattern, support-domain, and base-artifact identity changes', () => {
    const fixture = snapshot(threeRuns())
    const candidateId = clone(fixture.candidate)
    candidateId.id = hash(800)
    const lessonId = clone(fixture.support)
    lessonId.lesson.id = hash(801)
    const patternId = clone(fixture.support)
    patternId.lesson.pattern.id = hash(802)
    const supportDomain = clone(fixture.support)
    supportDomain.evidence[0]!.domainRef = hash(803)
    const wrongBase = artifact(hash(804), PROMPT)
    const wrongPromptBase = artifact(CONFIG, hash(805))

    expect(() => resolveCandidateSupport(candidateId, fixture.support, fixture.baseArtifact)).toThrow()
    expect(() => resolveCandidateSupport(fixture.candidate, lessonId, fixture.baseArtifact)).toThrow()
    expect(() => resolveCandidateSupport(fixture.candidate, patternId, fixture.baseArtifact)).toThrow()
    expect(() => resolveCandidateSupport(fixture.candidate, supportDomain, fixture.baseArtifact)).toThrow()
    expect(() => resolveCandidateSupport(fixture.candidate, fixture.support, wrongBase)).toThrow()
    expect(() => resolveCandidateSupport(fixture.candidate, fixture.support, wrongPromptBase)).toThrow()
  })

  it('returns identical canonical output for independently canonicalized equivalent pools', () => {
    const forward = snapshot(threeRuns())
    const reverse = snapshot([...threeRuns()].reverse())

    const left = resolveCandidateSupport(forward.candidate, forward.support, forward.baseArtifact)
    const right = resolveCandidateSupport(reverse.candidate, reverse.support, reverse.baseArtifact)

    expect(canonicalGovernanceJson(left)).toBe(canonicalGovernanceJson(right))
  })
})
