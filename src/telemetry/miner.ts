import {
  canonicalJson,
  type DatasetV1,
  type EvidenceRefV1,
  type PatternV1,
  type RunAnnotationV1,
} from '@han_05/dsh-telemetry/contracts'
import { createHash } from 'node:crypto'
import { getValidatedCompleteRunsV1, type ValidatedCompleteRunV1 } from './dataset.js'

const MAX_PATTERN_SUPPORT = 32
const MIN_SUPPORTING_RUNS = 3
const MIN_TASK_INSTANCES = 2

type SupportingRun = {
  runRef: string
  taskInstanceRef: string
  evidence: EvidenceRefV1[]
}

type Cohort = {
  category: NonNullable<RunAnnotationV1['failure']>['category']
  domainRef: string
  taskFamilyRef: string
  configHash: string
  promptHash: string
  supportingRuns: Map<string, SupportingRun>
}

function compareEvidence(left: EvidenceRefV1, right: EvidenceRefV1): number {
  return left.runRef.localeCompare(right.runRef) || left.seq - right.seq
}

function supportingEvidence(run: ValidatedCompleteRunV1): EvidenceRefV1[] | null {
  const annotation = run.annotation
  if (annotation === null || annotation.outcome !== 'failure' || annotation.failure === null) return null
  const failure = annotation.failure

  if (failure.attribution === 'reviewed') {
    return [...new Map(
      failure.evidence.map(evidence => [`${evidence.runRef}:${evidence.seq}`, evidence]),
    ).values()].sort(compareEvidence)
  }

  if (failure.category !== 'budget_exhaustion') return null
  const budgetOrdinals = new Set(
    run.observations.filter(observation => observation.kind === 'budget-rejected').map(observation => observation.seq),
  )
  const evidence = [...new Map(
    failure.evidence
      .filter(reference => budgetOrdinals.has(reference.seq))
      .map(reference => [`${reference.runRef}:${reference.seq}`, reference]),
  ).values()].sort(compareEvidence)
  return evidence.length === 0 ? null : evidence
}

function selectSupportingRuns(supportingRuns: SupportingRun[]): SupportingRun[] {
  const sorted = [...supportingRuns].sort((left, right) => left.runRef.localeCompare(right.runRef))
  const selected = sorted.slice(0, MAX_PATTERN_SUPPORT)
  if (new Set(selected.map(run => run.taskInstanceRef)).size >= MIN_TASK_INSTANCES) return selected

  const firstTask = selected[0]?.taskInstanceRef
  const diverseRun = sorted.slice(MAX_PATTERN_SUPPORT).find(run => run.taskInstanceRef !== firstTask)
  if (diverseRun !== undefined) selected[selected.length - 1] = diverseRun
  return selected.sort((left, right) => left.runRef.localeCompare(right.runRef))
}

function selectEvidence(supportingRuns: SupportingRun[]): EvidenceRefV1[] {
  const selected = new Map<string, EvidenceRefV1>()
  for (const run of supportingRuns) {
    const evidence = run.evidence[0]
    if (evidence !== undefined) selected.set(`${evidence.runRef}:${evidence.seq}`, evidence)
  }
  const remaining = supportingRuns.flatMap(run => run.evidence).sort(compareEvidence)
  for (const evidence of remaining) {
    if (selected.size >= MAX_PATTERN_SUPPORT) break
    selected.set(`${evidence.runRef}:${evidence.seq}`, evidence)
  }
  return [...selected.values()].sort(compareEvidence)
}

function patternId(body: Omit<PatternV1, 'id'>): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')
}

/** Mine deterministic, bounded patterns from repeated, explicitly attributed complete failures. */
export function mineFailures(dataset: DatasetV1): PatternV1[] {
  const cohorts = new Map<string, Cohort>()
  for (const run of getValidatedCompleteRunsV1(dataset)) {
    const annotation = run.annotation
    const evidence = supportingEvidence(run)
    if (annotation === null || annotation.failure === null || evidence === null) continue

    const key = canonicalJson([
      annotation.domainRef,
      annotation.taskFamilyRef,
      annotation.configHash,
      annotation.promptHash,
      annotation.failure.category,
    ])
    const cohort = cohorts.get(key) ?? {
      category: annotation.failure.category,
      domainRef: annotation.domainRef,
      taskFamilyRef: annotation.taskFamilyRef,
      configHash: annotation.configHash,
      promptHash: annotation.promptHash,
      supportingRuns: new Map<string, SupportingRun>(),
    }
    cohort.supportingRuns.set(annotation.runRef, {
      runRef: annotation.runRef,
      taskInstanceRef: annotation.taskInstanceRef,
      evidence,
    })
    cohorts.set(key, cohort)
  }

  const patterns: PatternV1[] = []
  for (const cohort of cohorts.values()) {
    const allSupportingRuns = [...cohort.supportingRuns.values()]
    if (allSupportingRuns.length < MIN_SUPPORTING_RUNS) continue
    if (new Set(allSupportingRuns.map(run => run.taskInstanceRef)).size < MIN_TASK_INSTANCES) continue

    const supportingRuns = selectSupportingRuns(allSupportingRuns)
    if (new Set(supportingRuns.map(run => run.taskInstanceRef)).size < MIN_TASK_INSTANCES) continue
    const body: Omit<PatternV1, 'id'> = {
      schemaVersion: 1,
      category: cohort.category,
      domainRef: cohort.domainRef,
      taskFamilyRef: cohort.taskFamilyRef,
      configHash: cohort.configHash,
      promptHash: cohort.promptHash,
      runRefs: supportingRuns.map(run => run.runRef),
      taskInstanceRefs: [...new Set(supportingRuns.map(run => run.taskInstanceRef))].sort(),
      evidence: selectEvidence(supportingRuns),
    }
    patterns.push({ ...body, id: patternId(body) })
  }
  return patterns.sort((left, right) => left.id.localeCompare(right.id))
}
