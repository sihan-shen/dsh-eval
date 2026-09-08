import {
  FAILURE_CLASSES,
  type CandidateV1,
  type EvidenceRefV1,
  type FailureClassV1,
  type LessonV1,
  type PatternV1,
} from '@han_05/dsh-telemetry/contracts'
import { canonicalGovernanceJson, sha256Canonical } from './canonical.js'
import type {
  CandidateSupportRunV1,
  CandidateSupportV1,
  TemplateArtifactV1,
} from './contracts.js'
import { validateCandidateSupportV1, validateTemplateArtifactV1 } from './validate.js'

const MAX_PATTERN_SUPPORT = 32
const MIN_SUPPORTING_RUNS = 3
const MIN_TASK_INSTANCES = 2

type SupportingRun = {
  runRef: string
  taskInstanceRef: string
  evidence: EvidenceRefV1[]
}

function fail(code: string): never {
  throw new TypeError(`candidate support replay ${code}`)
}

function same(left: unknown, right: unknown): boolean {
  return canonicalGovernanceJson(left) === canonicalGovernanceJson(right)
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareEvidence(left: EvidenceRefV1, right: EvidenceRefV1): number {
  return compareAscii(left.runRef, right.runRef) || left.seq - right.seq
}

function evidenceKey(value: EvidenceRefV1): string {
  return `${value.runRef}\u0000${String(value.seq).padStart(16, '0')}`
}

function sortedUniqueEvidence(values: readonly EvidenceRefV1[]): EvidenceRefV1[] {
  const unique = new Map<string, EvidenceRefV1>()
  for (const value of values) unique.set(evidenceKey(value), { ...value })
  return [...unique.values()].sort(compareEvidence)
}

function eligibleEvidence(run: CandidateSupportRunV1): EvidenceRefV1[] {
  const annotation = run.annotation
  const failure = annotation?.failure
  if (!annotation || annotation.outcome !== 'failure' || !failure) fail('pool-failure')
  if (!FAILURE_CLASSES.includes(failure.category)) fail('failure-category')
  if (failure.attribution === 'reviewed') return sortedUniqueEvidence(failure.evidence)
  if (failure.category !== 'budget_exhaustion') fail('observed-category')

  const observations = new Map(run.observations.map(item => [item.seq, item]))
  const eligible = sortedUniqueEvidence(failure.evidence.filter(reference => (
    observations.get(reference.seq)?.kind === 'budget-rejected'
  )))
  if (eligible.length === 0) fail('observed-budget-evidence')
  return eligible
}

function selectRuns(pool: readonly SupportingRun[]): SupportingRun[] {
  if (pool.length < MIN_SUPPORTING_RUNS) fail('minimum-runs')
  if (new Set(pool.map(run => run.taskInstanceRef)).size < MIN_TASK_INSTANCES) fail('minimum-task-instances')

  const sorted = [...pool].sort((left, right) => compareAscii(left.runRef, right.runRef))
  const selected = sorted.slice(0, MAX_PATTERN_SUPPORT)
  if (new Set(selected.map(run => run.taskInstanceRef)).size < MIN_TASK_INSTANCES) {
    const firstTask = selected[0]?.taskInstanceRef
    const replacement = sorted.slice(MAX_PATTERN_SUPPORT).find(run => run.taskInstanceRef !== firstTask)
    if (!replacement || selected.length === 0) fail('selected-task-diversity')
    selected[selected.length - 1] = replacement
    selected.sort((left, right) => compareAscii(left.runRef, right.runRef))
  }
  if (selected.length < MIN_SUPPORTING_RUNS
    || new Set(selected.map(run => run.taskInstanceRef)).size < MIN_TASK_INSTANCES) {
    fail('selected-support')
  }
  return selected
}

function selectEvidence(runs: readonly SupportingRun[]): EvidenceRefV1[] {
  const selected = new Map<string, EvidenceRefV1>()
  for (const run of runs) {
    const first = run.evidence[0]
    if (!first) fail('run-evidence')
    selected.set(evidenceKey(first), { ...first })
  }
  const union = runs.flatMap(run => run.evidence.map(item => ({ ...item }))).sort(compareEvidence)
  for (const evidence of union) {
    if (selected.size >= MAX_PATTERN_SUPPORT) break
    selected.set(evidenceKey(evidence), evidence)
  }
  const result = [...selected.values()].sort(compareEvidence)
  if (result.length < MIN_SUPPORTING_RUNS || result.length > MAX_PATTERN_SUPPORT) fail('evidence-count')
  const coveredRuns = new Set(result.map(item => item.runRef))
  if (runs.some(run => !coveredRuns.has(run.runRef))) fail('evidence-coverage')
  return result
}

function ruleFor(category: FailureClassV1): LessonV1['rule'] {
  if (category === 'context_loss' || category === 'insufficient_context' || category === 'context_bloat') {
    return 'review-context-boundary'
  }
  if (category === 'verification_gap') return 'review-verification-scope'
  if (category === 'wrong_model' || category === 'bad_routing' || category === 'prompt_incompatibility') {
    return 'review-route-fit'
  }
  return 'review-failure-evidence'
}

/** Replay a complete supplied v0.5 support pool into one governed prompt-candidate snapshot. */
export function resolveCandidateSupport(
  candidateInput: CandidateV1,
  supportInput: CandidateSupportV1,
  baseArtifactInput: TemplateArtifactV1,
): CandidateSupportV1 {
  const support = validateCandidateSupportV1(supportInput)
  const baseArtifact = validateTemplateArtifactV1(baseArtifactInput)
  const claimedPattern = support.lesson.pattern
  const pool = support.runs.map(run => ({
    runRef: run.runRef,
    taskInstanceRef: run.annotation!.taskInstanceRef,
    evidence: eligibleEvidence(run),
  }))
  const selectedRuns = selectRuns(pool)
  const evidence = selectEvidence(selectedRuns)
  const patternBody: Omit<PatternV1, 'id'> = {
    schemaVersion: 1,
    category: support.runs[0]!.annotation!.failure!.category,
    domainRef: support.runs[0]!.domainRef,
    taskFamilyRef: support.runs[0]!.annotation!.taskFamilyRef,
    configHash: support.runs[0]!.annotation!.configHash,
    promptHash: support.runs[0]!.annotation!.promptHash,
    runRefs: selectedRuns.map(run => run.runRef),
    taskInstanceRefs: [...new Set(selectedRuns.map(run => run.taskInstanceRef))].sort(compareAscii),
    evidence,
  }
  const pattern: PatternV1 = { ...patternBody, id: sha256Canonical(patternBody) }
  if (!same(claimedPattern, pattern)) fail('pattern-snapshot')

  const rule = ruleFor(pattern.category)
  const lessonBody: Omit<LessonV1, 'id'> = {
    schemaVersion: 1,
    revision: 1,
    pattern,
    rule,
  }
  const lesson: LessonV1 = { ...lessonBody, id: sha256Canonical(lessonBody) }
  if (!same(support.lesson, lesson)) fail('lesson-snapshot')

  const expectedSupportEvidence = evidence.map(item => ({ domainRef: pattern.domainRef, ...item }))
  if (!same(support.evidence, expectedSupportEvidence)) fail('domain-evidence')
  if (pattern.configHash !== baseArtifact.configHash || pattern.promptHash !== baseArtifact.promptHash) {
    fail('base-artifact')
  }

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
  const candidate: CandidateV1 = { ...candidateBody, id: sha256Canonical(candidateBody) }
  if (!same(candidateInput, candidate)) fail('candidate-snapshot')
  return support
}
