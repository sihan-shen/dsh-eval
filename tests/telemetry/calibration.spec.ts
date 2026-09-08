import type { DatasetV1, RunAnnotationV1 } from '@han_05/dsh-telemetry/contracts'
import { describe, expect, it } from 'vitest'
import { calibrateModels } from '../../src/telemetry/calibration.js'
import { annotation, observation, ref, seal } from './fixture.js'

const id = (value: number): string => value.toString(16).padStart(64, '0')

function addRun(
  dataset: DatasetV1,
  value: number,
  outcome: RunAnnotationV1['outcome'],
  routeRefs: string[] = [ref('a')],
  overrides: Partial<RunAnnotationV1> = {},
): void {
  const runRef = id(value)
  const events = routeRefs.map((routeRef, index) => observation(runRef, index + 1, index === 0 ? 'run-started' : 'schedule-selected', {
    facts: { routeRef, scope: 'root' },
  }))
  dataset.records.push(...events, seal(runRef, events.length))
  dataset.annotations.push(annotation(runRef, {
    outcome,
    accepted: outcome === 'unknown' ? null : outcome === 'success',
    failure: outcome === 'failure'
      ? { category: 'tool_misuse', attribution: 'reviewed', evidence: [{ runRef, seq: 1 }] }
      : null,
    evidence: [{ runRef, seq: 1 }],
    ...overrides,
  }))
}

describe('calibrateModels', () => {
  it('returns no observations for empty, unknown, incomplete or multi-route runs', () => {
    const dataset: DatasetV1 = { records: [], annotations: [] }
    addRun(dataset, 1, 'unknown')
    addRun(dataset, 2, 'success', [ref('a'), ref('b')])
    const incomplete = id(3)
    dataset.records.push(observation(incomplete, 1), seal(incomplete, 1, { complete: false }))
    dataset.annotations.push(annotation(incomplete))
    expect(calibrateModels(dataset)).toEqual([])
  })

  it('keeps family, config and prompt cohorts separate', () => {
    const dataset: DatasetV1 = { records: [], annotations: [] }
    addRun(dataset, 10, 'success')
    addRun(dataset, 11, 'failure', [ref('a')], { taskFamilyRef: ref('5') })
    addRun(dataset, 12, 'success', [ref('a')], { configHash: ref('6') })
    addRun(dataset, 13, 'failure', [ref('a')], { promptHash: ref('7') })

    const report = calibrateModels(dataset)
    expect(report).toHaveLength(4)
    expect(new Set(report.map(row => `${row.taskFamilyRef}:${row.configHash}:${row.promptHash}`)).size).toBe(4)
    expect(report.every(row => row.samples === 1 && row.sufficient === false)).toBe(true)
  })

  it('reports all-success, all-failure and mixed Wilson intervals', () => {
    const successes: DatasetV1 = { records: [], annotations: [] }
    const failures: DatasetV1 = { records: [], annotations: [] }
    const mixed: DatasetV1 = { records: [], annotations: [] }
    for (let index = 0; index < 3; index += 1) {
      addRun(successes, 100 + index, 'success')
      addRun(failures, 200 + index, 'failure')
      addRun(mixed, 300 + index, index < 2 ? 'success' : 'failure')
    }

    expect(calibrateModels(successes)[0]).toMatchObject({ samples: 3, successes: 3, successRate: 1, sufficient: true })
    expect(calibrateModels(successes)[0].interval95).toEqual([expect.any(Number), 1])
    expect(calibrateModels(failures)[0]).toMatchObject({ samples: 3, successes: 0, successRate: 0, sufficient: true })
    expect(calibrateModels(failures)[0].interval95).toEqual([0, expect.any(Number)])
    expect(calibrateModels(mixed)[0]).toMatchObject({ samples: 3, successes: 2, successRate: 2 / 3, sufficient: true })
  })

  it('selects at most 32 runs stably with one route provenance ref per run', () => {
    const dataset: DatasetV1 = { records: [], annotations: [] }
    for (let index = 0; index < 40; index += 1) addRun(dataset, 500 + index, index % 2 === 0 ? 'success' : 'failure')
    const reversed = { records: [...dataset.records].reverse(), annotations: [...dataset.annotations].reverse() }
    const row = calibrateModels(dataset)[0]

    expect(calibrateModels(reversed)).toEqual(calibrateModels(dataset))
    expect(row.samples).toBe(32)
    expect(row.successes).toBe(16)
    expect(row.evidence).toHaveLength(32)
    expect(new Set(row.evidence.map(item => item.runRef)).size).toBe(32)
    expect(row.evidence.map(item => item.runRef)).toEqual(Array.from({ length: 32 }, (_, index) => id(500 + index)))
    expect(row.evidence.every(item => item.seq === 1)).toBe(true)
    expect(row.samples).toBeGreaterThanOrEqual(row.successes)
    expect(row.sufficient).toBe(row.samples >= 3)
  })
})
