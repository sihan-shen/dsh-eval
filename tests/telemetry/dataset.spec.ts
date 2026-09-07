import { describe, expect, it } from 'vitest'
import { getValidatedCompleteRunsV1, parseDatasetV1 } from '../../src/telemetry/dataset.js'
import { annotation, observation, ref, seal } from './fixture.js'

describe('parseDatasetV1', () => {
  it('deduplicates byte-identical records and annotations idempotently', () => {
    const runRef = ref('5')
    const event = observation(runRef, 1)
    const end = seal(runRef, 1)
    const review = annotation(runRef)
    const dataset = parseDatasetV1([event, event, end, end], [review, review])
    expect(dataset.records).toEqual([event, end])
    expect(dataset.annotations).toEqual([review])
    expect(getValidatedCompleteRunsV1(dataset)).toHaveLength(1)
  })

  it('rejects conflicting observations for the same domain, run and ordinal', () => {
    const runRef = ref('5')
    expect(() => parseDatasetV1([
      observation(runRef, 1),
      observation(runRef, 1, 'schedule-selected'),
    ], [])).toThrow(/conflicting.*record/i)
  })

  it('rejects conflicting seals rather than selecting the favorable copy', () => {
    const runRef = ref('5')
    expect(() => parseDatasetV1([
      observation(runRef, 1),
      seal(runRef, 1),
      seal(runRef, 1, { complete: false }),
    ], [])).toThrow(/conflicting.*seal|conflicting.*record/i)
  })

  it('rejects conflicting duplicate annotations', () => {
    const runRef = ref('5')
    expect(() => parseDatasetV1(
      [observation(runRef, 1), seal(runRef, 1)],
      [annotation(runRef), annotation(runRef, { accepted: false })],
    )).toThrow(/conflicting.*annotation/i)
  })

  it('rejects evidence references with a missing observation ordinal', () => {
    const runRef = ref('5')
    expect(() => parseDatasetV1(
      [observation(runRef, 1), seal(runRef, 1)],
      [annotation(runRef, { evidence: [{ runRef, seq: 2 }] })],
    )).toThrow(/evidence.*resolve/i)
  })

  it('rejects evidence references to another run', () => {
    const runRef = ref('5')
    expect(() => parseDatasetV1(
      [observation(runRef, 1), seal(runRef, 1)],
      [annotation(runRef, { evidence: [{ runRef: ref('6'), seq: 1 }] })],
    )).toThrow(/evidence.*run/i)
  })

  it('rejects cross-domain evidence resolution', () => {
    const runRef = ref('5')
    expect(() => parseDatasetV1(
      [observation(runRef, 1), seal(runRef, 1)],
      [annotation(runRef, { domainRef: ref('c') })],
    )).toThrow(/evidence.*resolve/i)
  })

  it('validates failure evidence independently of general annotation evidence', () => {
    const runRef = ref('5')
    expect(() => parseDatasetV1(
      [observation(runRef, 1), seal(runRef, 1)],
      [annotation(runRef, {
        outcome: 'failure',
        accepted: false,
        failure: { category: 'tool_misuse', attribution: 'reviewed', evidence: [{ runRef, seq: 2 }] },
      })],
    )).toThrow(/failure.*evidence.*resolve/i)
  })

  it('excludes a seal whose observation count mismatches retained records', () => {
    const runRef = ref('5')
    const dataset = parseDatasetV1(
      [observation(runRef, 1), seal(runRef, 2)],
      [annotation(runRef)],
    )
    expect(getValidatedCompleteRunsV1(dataset)).toEqual([])
  })

  it('excludes incomplete, lossy and unsealed runs', () => {
    const incomplete = ref('5')
    const lossy = ref('6')
    const unsealed = ref('7')
    const dataset = parseDatasetV1([
      observation(incomplete, 1), seal(incomplete, 1, { complete: false }),
      observation(lossy, 1), seal(lossy, 1, { complete: false, lostCount: 1 }),
      observation(unsealed, 1),
    ], [annotation(incomplete), annotation(lossy), annotation(unsealed)])
    expect(getValidatedCompleteRunsV1(dataset)).toEqual([])
  })

  it('does not treat a retained suffix as complete when ordinal one is missing', () => {
    const runRef = ref('5')
    const dataset = parseDatasetV1(
      [observation(runRef, 2), seal(runRef, 1)],
      [annotation(runRef, { evidence: [{ runRef, seq: 2 }] })],
    )
    expect(getValidatedCompleteRunsV1(dataset)).toEqual([])
  })

  it('rejects unsupported schemas and an oversized telemetry line', () => {
    expect(() => parseDatasetV1([], [{ schemaVersion: 1 }])).toThrow(TypeError)
    const runRef = ref('5')
    expect(() => parseDatasetV1([{ ...observation(runRef, 1), padding: 'x'.repeat(8_192) }], []))
      .toThrow(/byte limit/i)
  })

  it('checks collection count bounds before parsing members', () => {
    const malformed = { schemaVersion: 99 }
    expect(() => parseDatasetV1(new Array(65_537).fill(malformed), [])).toThrow(/65,?536|record count/i)
    expect(() => parseDatasetV1([], new Array(4_097).fill(malformed))).toThrow(/4,?096|annotation count/i)
  })

  it('enforces aggregate telemetry and annotation byte bounds', () => {
    const runRef = ref('5')
    const telemetry = Array.from({ length: 30_000 }, (_, index) => observation(runRef, index + 1))
    expect(() => parseDatasetV1(telemetry, [])).toThrow(/telemetry.*byte/i)

    const annotationRecords = Array.from({ length: 4_096 }, (_, index) => {
      const itemRunRef = index.toString(16).padStart(64, '0')
      return observation(itemRunRef, 1)
    })
    const many = annotationRecords.map((record, index) => annotation(record.runRef, {
      taskInstanceRef: index.toString(16).padStart(64, '0'),
      evidence: Array.from({ length: 32 }, () => ({ runRef: record.runRef, seq: 1 })),
    }))
    expect(() => parseDatasetV1(annotationRecords, many)).toThrow(/annotation.*byte/i)
  })
})
