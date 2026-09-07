import {
  canonicalJson,
  type CandidateV1,
  type DatasetV1,
  type LessonV1,
  type RunAnnotationV1,
} from '@ds-plugins/dsh-telemetry/contracts'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildCandidates } from '../../src/telemetry/candidates.js'
import { buildLessons } from '../../src/telemetry/lessons.js'
import { mineFailures } from '../../src/telemetry/miner.js'
import { annotation, observation, ref, seal } from './fixture.js'

const runRef = (index: number): string => index.toString(16).padStart(64, '0')

function failureAnnotation(run: string, task: string, overrides: Partial<RunAnnotationV1> = {}): RunAnnotationV1 {
  return annotation(run, {
    taskInstanceRef: task,
    outcome: 'failure',
    accepted: false,
    failure: {
      category: 'budget_exhaustion',
      attribution: 'observed',
      evidence: [{ runRef: run, seq: 1 }],
    },
    evidence: [{ runRef: run, seq: 1 }],
    ...overrides,
  })
}

function repeatedDataset(): DatasetV1 {
  const runs = [runRef(1), runRef(2), runRef(3)]
  return {
    records: runs.flatMap(run => [observation(run, 1, 'budget-rejected'), seal(run, 1)]),
    annotations: runs.map((run, index) => failureAnnotation(run, index === 2 ? ref('9') : ref('8'))),
  }
}

function lessonsFor(dataset: DatasetV1): LessonV1[] {
  return buildLessons(mineFailures(dataset))
}

function candidateId(candidate: CandidateV1): string {
  const { id: _id, ...body } = candidate
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')
}

describe('buildCandidates', () => {
  it('builds three inert, content-addressed hypotheses from repeated evidence', () => {
    const dataset = repeatedDataset()
    const lesson = lessonsFor(dataset)[0]
    const candidates = buildCandidates([lesson], dataset)

    expect(candidates.map(candidate => candidate.kind).sort()).toEqual(['prompt', 'routing', 'skill'])
    for (const candidate of candidates) {
      expect(candidate).toEqual({
        schemaVersion: 1,
        id: candidateId(candidate),
        revision: 1,
        kind: candidate.kind,
        status: 'proposed',
        lessonId: lesson.id,
        baseConfigHash: lesson.pattern.configHash,
        basePromptHash: lesson.pattern.promptHash,
        hypothesis: 'review-failure-evidence',
        evidence: lesson.pattern.evidence,
        evaluationRequired: true,
        autoPromote: false,
      })
      expect(Object.keys(candidate).sort()).toEqual([
        'autoPromote', 'baseConfigHash', 'basePromptHash', 'evaluationRequired', 'evidence', 'hypothesis',
        'id', 'kind', 'lessonId', 'revision', 'schemaVersion', 'status',
      ].sort())
    }
  })

  it('requires the exact canonical lesson and support rebuilt from the current dataset', () => {
    const original = repeatedDataset()
    const lesson = lessonsFor(original)[0]
    const removedRun = runRef(3)
    const withoutRun: DatasetV1 = {
      records: original.records.filter(record => record.runRef !== removedRun),
      annotations: original.annotations.filter(item => item.runRef !== removedRun),
    }
    const changedObservation: DatasetV1 = {
      records: original.records.map(record => record.kind === 'budget-rejected' && record.runRef === runRef(2)
        ? observation(record.runRef, 1, 'run-started')
        : record),
      annotations: original.annotations,
    }
    const missingObservation: DatasetV1 = {
      records: original.records.filter(record => !(record.kind === 'budget-rejected' && record.runRef === runRef(2))),
      annotations: original.annotations,
    }
    const oneTask: DatasetV1 = {
      records: original.records,
      annotations: original.annotations.map(item => ({ ...item, taskInstanceRef: ref('8') })),
    }

    expect(buildCandidates([lesson], withoutRun)).toEqual([])
    expect(buildCandidates([lesson], changedObservation)).toEqual([])
    expect(() => buildCandidates([lesson], missingObservation)).toThrow(/evidence.*does not resolve/i)
    expect(buildCandidates([lesson], oneTask)).toEqual([])
    expect(buildCandidates([{ ...lesson, id: ref('f') }], original)).toEqual([])
  })

  it('does not carry a valid lesson across telemetry domains or changed cohorts', () => {
    const original = repeatedDataset()
    const lesson = lessonsFor(original)[0]
    const otherDomain = ref('c')
    const crossDomain: DatasetV1 = {
      records: original.records.map(record => ({ ...record, domainRef: otherDomain })),
      annotations: original.annotations.map(item => ({ ...item, domainRef: otherDomain })),
    }
    const changedHashes: DatasetV1 = {
      records: original.records,
      annotations: original.annotations.map(item => ({ ...item, configHash: ref('7') })),
    }

    expect(lessonsFor(crossDomain)).toHaveLength(1)
    expect(buildCandidates([lesson], crossDomain)).toEqual([])
    expect(buildCandidates([lesson], changedHashes)).toEqual([])
  })

  it('deduplicates identical lessons and does not mutate caller-owned inputs', () => {
    const dataset = repeatedDataset()
    const lesson = lessonsFor(dataset)[0]
    const datasetBefore = structuredClone(dataset)
    const lessons = [lesson, structuredClone(lesson)]
    const lessonsBefore = structuredClone(lessons)

    expect(buildCandidates(lessons, dataset)).toHaveLength(3)
    expect(dataset).toEqual(datasetBefore)
    expect(lessons).toEqual(lessonsBefore)
  })

  it('rejects lesson-shaped objects with extra deployable or free-form content', () => {
    const dataset = repeatedDataset()
    const lesson = lessonsFor(dataset)[0]
    const unsafe = {
      ...lesson,
      patch: 'execute arbitrary changes',
      promptBody: 'replace the production system prompt',
    } as LessonV1

    expect(buildCandidates([unsafe], dataset)).toEqual([])
  })
})
