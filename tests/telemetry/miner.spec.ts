import { FAILURE_CLASSES, type DatasetV1, type FailureClassV1, type RunAnnotationV1 } from '@ds-plugins/dsh-telemetry/contracts'
import { describe, expect, it } from 'vitest'
import { mineFailures } from '../../src/telemetry/miner.js'
import { annotation, observation, ref, seal } from './fixture.js'

const id = (value: number): string => value.toString(16).padStart(64, '0')

function failureAnnotation(
  runRef: string,
  taskInstanceRef: string,
  category: FailureClassV1 = 'budget_exhaustion',
  attribution: 'observed' | 'reviewed' = category === 'budget_exhaustion' ? 'observed' : 'reviewed',
  overrides: Partial<RunAnnotationV1> = {},
): RunAnnotationV1 {
  return annotation(runRef, {
    taskInstanceRef,
    outcome: 'failure',
    accepted: false,
    failure: { category, attribution, evidence: [{ runRef, seq: 1 }] },
    evidence: [{ runRef, seq: 1 }],
    ...overrides,
  })
}

function budgetDataset(count: number, configHash = ref('3')): DatasetV1 {
  const records: DatasetV1['records'] = []
  const annotations: DatasetV1['annotations'] = []
  for (let index = 0; index < count; index += 1) {
    const runRef = id(index + 1)
    records.push(observation(runRef, 1, 'budget-rejected'), seal(runRef, 1))
    annotations.push(failureAnnotation(runRef, id(1_000 + (index % 2)), 'budget_exhaustion', 'observed', { configHash }))
  }
  return { records, annotations }
}

describe('mineFailures', () => {
  it('requires three distinct complete runs and two tasks in one exact cohort', () => {
    expect(mineFailures(budgetDataset(1))).toEqual([])
    expect(mineFailures(budgetDataset(2))).toEqual([])

    const three = budgetDataset(3)
    const otherRunRef = id(99)
    const differentConfig = {
      records: [observation(otherRunRef, 1, 'budget-rejected'), seal(otherRunRef, 1)],
      annotations: [failureAnnotation(otherRunRef, id(1_099), 'budget_exhaustion', 'observed', { configHash: ref('9') })],
    }
    const dataset = {
      records: [...three.records, ...differentConfig.records, ...three.records.slice(0, 2), ...three.records.slice(0, 2)],
      annotations: [...three.annotations, ...differentConfig.annotations, three.annotations[0], three.annotations[0]],
    }
    const patterns = mineFailures(dataset)

    expect(patterns).toHaveLength(1)
    expect(patterns[0].category).toBe('budget_exhaustion')
    expect(new Set(patterns[0].runRefs).size).toBe(3)
    expect(new Set(patterns[0].taskInstanceRefs).size).toBe(2)
  })

  it('supports every reviewed failure class but only observed budget rejections', () => {
    const records: DatasetV1['records'] = []
    const annotations: DatasetV1['annotations'] = []
    FAILURE_CLASSES.forEach((category, categoryIndex) => {
      for (let index = 0; index < 3; index += 1) {
        const runRef = id(100 + categoryIndex * 3 + index)
        const kind = category === 'budget_exhaustion' ? 'budget-rejected' : 'run-started'
        records.push(observation(runRef, 1, kind), seal(runRef, 1))
        annotations.push(failureAnnotation(runRef, id(2_000 + (index % 2)), category))
      }
    })

    const patterns = mineFailures({ records, annotations })
    expect(patterns.map(pattern => pattern.category).sort()).toEqual([...FAILURE_CLASSES].sort())
  })

  it('excludes incomplete and unsupported observed attributions', () => {
    const records: DatasetV1['records'] = []
    const annotations: DatasetV1['annotations'] = []
    const cases: Array<{
      category: FailureClassV1
      complete?: boolean
      event?: 'budget-rejected' | 'verification-finished'
      attribution?: 'observed' | 'reviewed'
    }> = [
      { category: 'budget_exhaustion', event: 'verification-finished', attribution: 'observed' },
      { category: 'implementation_error', event: 'verification-finished', attribution: 'observed' },
      { category: 'verification_gap', event: 'verification-finished', attribution: 'observed' },
      { category: 'provider_failure', attribution: 'observed' },
      { category: 'tool_misuse', complete: false },
    ]
    cases.forEach((item, caseIndex) => {
      for (let index = 0; index < 3; index += 1) {
        const runRef = id(300 + caseIndex * 3 + index)
        records.push(
          observation(runRef, 1, item.event ?? 'run-started', item.event === 'verification-finished'
            ? { facts: { status: 'failed', durationMs: 1 } }
            : {}),
          seal(runRef, 1, { complete: item.complete ?? true }),
        )
        annotations.push(failureAnnotation(runRef, id(3_000 + (index % 2)), item.category, item.attribution ?? 'reviewed'))
      }
    })

    expect(mineFailures({ records, annotations })).toEqual([])
  })

  it('revalidates and rejects contradictory annotations while ignoring unknown outcomes', () => {
    const runRef = id(400)
    const records = [observation(runRef, 1), seal(runRef, 1)]
    const contradictory = failureAnnotation(runRef, id(4_000), 'tool_misuse', 'reviewed', { outcome: 'success' })
    expect(() => mineFailures({ records, annotations: [contradictory] })).toThrow(/failure.*failure outcome/i)

    const unknown = annotation(runRef, { outcome: 'unknown', accepted: null, failure: null })
    expect(mineFailures({ records, annotations: [unknown] })).toEqual([])
  })

  it('produces canonical patterns and ids independent of input ordering', () => {
    const dataset = budgetDataset(4)
    const reversed = {
      records: [...dataset.records].reverse(),
      annotations: [...dataset.annotations].reverse(),
    }

    expect(mineFailures(reversed)).toEqual(mineFailures(dataset))
    expect(mineFailures(dataset)[0].id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('caps support and evidence at 32 while retaining two selected tasks and one ref per run', () => {
    const records: DatasetV1['records'] = []
    const annotations: DatasetV1['annotations'] = []
    for (let index = 0; index < 40; index += 1) {
      const runRef = id(500 + index)
      records.push(observation(runRef, 1, 'run-started'), observation(runRef, 2, 'worker-finished'), seal(runRef, 2))
      annotations.push(failureAnnotation(runRef, index === 39 ? id(9_999) : id(9_998), 'tool_misuse', 'reviewed', {
        failure: {
          category: 'tool_misuse',
          attribution: 'reviewed',
          evidence: [{ runRef, seq: 2 }, { runRef, seq: 1 }, { runRef, seq: 1 }],
        },
      }))
    }

    const pattern = mineFailures({ records, annotations })[0]
    expect(pattern.runRefs).toHaveLength(32)
    expect(pattern.evidence).toHaveLength(32)
    expect(pattern.taskInstanceRefs).toEqual([id(9_998), id(9_999)])
    expect(new Set(pattern.evidence.map(item => item.runRef))).toEqual(new Set(pattern.runRefs))
    expect(pattern.evidence.every(item => item.seq === 1)).toBe(true)
  })
})
