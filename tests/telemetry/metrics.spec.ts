import { describe, expect, it } from 'vitest'
import { parseDatasetV1 } from '../../src/telemetry/dataset.js'
import { computeTelemetryMetrics } from '../../src/telemetry/metrics.js'
import { annotation, completeRun, observation, ref } from './fixture.js'

const unavailableKeys = [
  'cache_hit_ratio',
  'uncached_tokens_per_success',
  'source_token_estimate',
  'uncached_source_tokens',
  'lsp_to_source_ratio',
  'worker_reuse_rate',
  'retry_rate',
  'latency_per_success',
  'fallback_rate',
] as const

describe('computeTelemetryMetrics', () => {
  it('returns the complete metric inventory with honest unknown values for no evidence', () => {
    const metrics = computeTelemetryMetrics({ records: [], annotations: [] })
    expect(Object.keys(metrics).sort()).toEqual([
      'accepted_result_rate', 'cache_hit_ratio', 'fallback_rate', 'latency_per_success',
      'lsp_to_source_ratio', 'model_switch_rate', 'retry_rate', 'source_token_estimate',
      'task_success_rate', 'uncached_source_tokens', 'uncached_tokens_per_success',
      'verification_cost', 'worker_reuse_rate', 'worker_spawn_rate',
    ].sort())
    expect(metrics.task_success_rate).toEqual({
      value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 0, basis: 'unavailable',
    })
  })

  it('uses distinct outcome, acceptance and duration denominators across complete annotated runs', () => {
    const one = ref('5')
    const two = ref('6')
    const three = ref('7')
    const runOne = completeRun(one, [
      observation(one, 1),
      observation(one, 2, 'worker-requested'),
      observation(one, 3, 'verification-finished', { facts: { status: 'passed', durationMs: 12 } }),
    ], annotation(one, { outcome: 'success', accepted: true }))
    const runTwo = completeRun(two, [
      observation(two, 1, 'run-started', { facts: { routeRef: ref('a'), scope: 'root' } }),
      observation(two, 2, 'schedule-selected', { facts: { routeRef: ref('b'), scope: 'root' } }),
    ], annotation(two, { outcome: 'failure', accepted: false,
      failure: { category: 'tool_misuse', attribution: 'reviewed', evidence: [{ runRef: two, seq: 2 }] } }))
    const runThree = completeRun(three, [
      observation(three, 1),
      observation(three, 2, 'verification-finished', { facts: { status: 'passed', durationMs: 8 } }),
    ], annotation(three, { outcome: 'unknown', accepted: null }))
    const dataset = parseDatasetV1(
      [...runOne.records, ...runTwo.records, ...runThree.records],
      [runOne.annotation, runTwo.annotation, runThree.annotation],
    )
    const metrics = computeTelemetryMetrics(dataset)

    expect(metrics.task_success_rate).toEqual({
      value: 0.5, numerator: 1, denominator: 2, observedRuns: 2, eligibleRuns: 3, basis: 'observed',
    })
    expect(metrics.accepted_result_rate).toEqual({
      value: 0.5, numerator: 1, denominator: 2, observedRuns: 2, eligibleRuns: 3, basis: 'observed',
    })
    expect(metrics.worker_spawn_rate).toEqual({
      value: 1 / 3, numerator: 1, denominator: 3, observedRuns: 1, eligibleRuns: 3, basis: 'estimated',
    })
    expect(metrics.model_switch_rate).toEqual({
      value: 1, numerator: 1, denominator: 1, observedRuns: 1, eligibleRuns: 3, basis: 'observed',
    })
    expect(metrics.verification_cost).toEqual({
      value: 10, numerator: 20, denominator: 2, observedRuns: 2, eligibleRuns: 3, basis: 'observed',
    })
    for (const key of unavailableKeys) {
      expect(metrics[key]).toEqual({
        value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 0, basis: 'unavailable',
      })
    }
  })

  it('excludes an unsealed run instead of treating its missing verification duration as zero', () => {
    const complete = ref('5')
    const partial = ref('6')
    const dataset = parseDatasetV1([
      observation(complete, 1),
      observation(complete, 2, 'verification-finished', { facts: { status: 'passed', durationMs: 8 } }),
      { schemaVersion: 1, kind: 'run-seal', domainRef: ref('d'), runRef: complete, observationCount: 2, lostCount: 0, complete: true },
      observation(partial, 1),
      observation(partial, 2, 'verification-finished', { facts: { status: 'passed', durationMs: 100 } }),
    ], [annotation(complete), annotation(partial)])
    expect(computeTelemetryMetrics(dataset).verification_cost).toEqual({
      value: 8, numerator: 8, denominator: 1, observedRuns: 1, eligibleRuns: 1, basis: 'observed',
    })
  })

  it('reports model switching as unknown when no complete run supplies a route comparison', () => {
    const runRef = ref('5')
    const run = completeRun(runRef, [observation(runRef, 1)])
    expect(computeTelemetryMetrics(parseDatasetV1(run.records, [run.annotation])).model_switch_rate).toEqual({
      value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 1, basis: 'unavailable',
    })
  })

  it('refuses to publish an overflowed verification aggregate', () => {
    const one = ref('5')
    const two = ref('6')
    const first = completeRun(one, [
      observation(one, 1),
      observation(one, 2, 'verification-finished', { facts: { status: 'passed', durationMs: Number.MAX_SAFE_INTEGER } }),
    ])
    const second = completeRun(two, [
      observation(two, 1),
      observation(two, 2, 'verification-finished', { facts: { status: 'passed', durationMs: 1 } }),
    ], annotation(two))
    const metrics = computeTelemetryMetrics(parseDatasetV1(
      [...first.records, ...second.records],
      [first.annotation, second.annotation],
    ))
    expect(metrics.verification_cost).toEqual({
      value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 0, basis: 'unavailable',
    })
  })
})
