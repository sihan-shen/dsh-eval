import { describe, expect, it } from 'vitest'
import type {
  EvaluationRecordV1,
  EvaluationTaskV1,
  PromotionReportV1,
  SymbolMatchV1,
} from '@ds-plugins/dsh-context'
import { sha256Utf8 } from '@ds-plugins/dsh-context'
import manifest from '../fixtures/v0.2a/manifest.json'
import { computeRetrievalMetrics } from '../src/metrics.js'
import { evaluatePromotion } from '../src/reports.js'
import { estimateSourceTokensV1 } from '../src/tokenizer.js'
import type { RetrievalRunV1 } from '../src/types.js'

const task = (taskId: string, shape: EvaluationTaskV1['repository_shape'] = 'ts-small'): EvaluationTaskV1 => ({
  task_id: taskId,
  repository_shape: shape,
  revision: 'v0.2a-fixture-rev-1',
  query: 'load order',
  target_symbols: [{ path: 'src/auth.ts', name: 'loadOrder' }],
  baseline_paths: ['src/auth.ts'],
  byte_limit: 4096,
  verifier: {
    id: 'fixture-integrity-v1',
    expected_revision: 'v0.2a-fixture-rev-1',
    required_paths: ['src/auth.ts'],
  },
})

const match = (overrides: Partial<SymbolMatchV1> = {}): SymbolMatchV1 => ({
  symbolId: 'symbol-1',
  path: 'src/auth.ts',
  sourceHash: sha256Utf8('export function loadOrder() {}'),
  start: { line: 1, column: 16 },
  end: { line: 1, column: 25 },
  kind: 'function',
  name: 'loadOrder',
  score: 1,
  ...overrides,
})

const retrievalRun = (overrides: Partial<RetrievalRunV1> = {}): RetrievalRunV1 => ({
  task: task('metric-task'),
  revision: 'v0.2a-fixture-rev-1',
  ranked_results: [match()],
  source_text: { 'src/auth.ts': 'export function loadOrder() {}' },
  files: [{
    path: 'src/auth.ts',
    text: 'export function loadOrder() {}',
    content_hash: sha256Utf8('export function loadOrder() {}'),
    byte_length: new TextEncoder().encode('export function loadOrder() {}').byteLength,
  }],
  verifier_result: true,
  run_mode: 'baseline',
  cache_condition: 'none',
  run_index: 1,
  context_blocks_requested: 1,
  cache_hits: 0,
  cache_misses: 0,
  ...overrides,
})

const sourceMeasurement = (overrides: Partial<NonNullable<RetrievalRunV1['measurements']>[number]> = {}) => ({
  path: 'src/auth.ts',
  source_hash: sha256Utf8('export function loadOrder() {}'),
  start_offset: 16,
  end_offset: 25,
  text: 'loadOrder',
  byte_length: new TextEncoder().encode('loadOrder').byteLength,
  ...overrides,
})

const record = (overrides: Partial<EvaluationRecordV1> = {}): EvaluationRecordV1 => ({
  schema_version: 1,
  run_mode: 'baseline',
  task_id: 'task-1',
  cache_condition: 'none',
  run_index: 1,
  tokenizer_name: '@dqbd/tiktoken',
  tokenizer_encoding: 'cl100k_base',
  tokenizer_version: '1.0.22',
  source_token_estimate: 100,
  uncached_source_tokens: 100,
  context_blocks_requested: 1,
  cache_hits: 0,
  cache_misses: 0,
  symbol_query_precision: 1,
  symbol_query_recall_at_5: 1,
  symbol_query_mrr: 1,
  target_coverage: 1,
  oracle_success: true,
  verification_status: 'passed',
  duration_ms: 1,
  ...overrides,
})

const corpusTaskIds = (manifest as { tasks: { task_id: string }[] }).tasks.map(task => task.task_id)

const corpusRecords = (mode: 'baseline' | 'optimized', condition: 'none' | 'cold' | 'warm', sourceTokens: number, overrides: Partial<EvaluationRecordV1> = {}, taskIds = corpusTaskIds): EvaluationRecordV1[] =>
  taskIds.map((taskId) => {
    return Array.from({ length: 3 }, (_, runIndex) => record({
      task_id: taskId,
      run_mode: mode,
      cache_condition: condition,
      run_index: (runIndex + 1) as 1 | 2 | 3,
      source_token_estimate: sourceTokens,
      uncached_source_tokens: sourceTokens,
      ...overrides,
    }))
  }).flat()

describe('v0.2a deterministic tokenizer and retrieval metrics', () => {
  it('uses the fixed cl100k_base tokenizer for model-visible source text only', () => {
    expect(estimateSourceTokensV1('hello world')).toBeGreaterThan(0)
    expect(estimateSourceTokensV1('hello world')).toBe(estimateSourceTokensV1('hello world'))
    expect(estimateSourceTokensV1('hello world\nmetadata is excluded')).toBeGreaterThan(estimateSourceTokensV1('hello world'))
  })

  it('computes recall at five from the first five ranked results', () => {
    const results = [
      match({ name: 'unrelated-1', symbolId: 'u1' }),
      match({ name: 'unrelated-2', symbolId: 'u2' }),
      match({ name: 'unrelated-3', symbolId: 'u3' }),
      match({ name: 'unrelated-4', symbolId: 'u4' }),
      match({ name: 'loadOrder', symbolId: 'target' }),
      match({ name: 'loadOrder', symbolId: 'after-five' }),
    ]
    expect(computeRetrievalMetrics(retrievalRun({ ranked_results: results })).symbol_query_recall_at_5).toBe(1)
    expect(computeRetrievalMetrics(retrievalRun({ ranked_results: results })).symbol_query_mrr).toBe(0.2)
  })

  it('computes target coverage from valid path, range, and source hash provenance', () => {
    const validHash = computeRetrievalMetrics(retrievalRun()).target_coverage
    const invalid = computeRetrievalMetrics(retrievalRun({
      ranked_results: [match({ sourceHash: 'sha256:wrong', end: { line: 99, column: 0 } })],
    }))
    expect(validHash).toBe(1)
    expect(invalid.target_coverage).toBe(0)
    expect(invalid.oracle_success).toBe(false)
  })

  it('fails closed when verified files and model-visible source text diverge', () => {
    expect(() => computeRetrievalMetrics(retrievalRun({
      source_text: { 'src/auth.ts': 'export function forged() {}' },
      measurements: [sourceMeasurement()],
    }))).toThrow(/source binding/i)
    expect(computeRetrievalMetrics(retrievalRun({
      ranked_results: [match({ end: { line: 1, column: 20 } })],
    })).target_coverage).toBe(0)
  })

  it('requires complete target coverage, matching revision provenance, and verifier success for oracle success', () => {
    expect(computeRetrievalMetrics(retrievalRun()).oracle_success).toBe(true)
    expect(computeRetrievalMetrics(retrievalRun({ revision: 'wrong-revision' })).oracle_success).toBe(false)
    expect(computeRetrievalMetrics(retrievalRun({ verifier_result: false })).oracle_success).toBe(false)
  })

  it('requires explicit cache-miss token input for optimized runs', () => {
    expect(() => computeRetrievalMetrics(retrievalRun({ run_mode: 'optimized', cache_condition: 'cold' }))).toThrow(/uncached_source_tokens/i)
    expect(computeRetrievalMetrics(retrievalRun({ run_mode: 'optimized', cache_condition: 'cold', uncached_source_tokens: 7 })).uncached_source_tokens).toBe(7)
  })

  it('measures an exact UTF-16 source window from a verified file', () => {
    const result = computeRetrievalMetrics(retrievalRun({ run_mode: 'optimized', cache_condition: 'cold', uncached_source_tokens: 2, measurements: [sourceMeasurement()] }))
    expect(result.source_token_estimate).toBe(estimateSourceTokensV1('loadOrder'))
  })

  it('requires baseline measurements to cover each verified file in full', () => {
    expect(() => computeRetrievalMetrics(retrievalRun({ measurements: [sourceMeasurement()] }))).toThrow(/baseline.*full|full.*measurement/i)
  })

  it('rejects forged or unverified source measurements', () => {
    const cases = [
      sourceMeasurement({ text: 'forged' }),
      sourceMeasurement({ path: 'src/other.ts' }),
      sourceMeasurement({ source_hash: 'sha256:wrong' }),
      sourceMeasurement({ start_offset: 15 }),
      sourceMeasurement({ end_offset: 24 }),
      sourceMeasurement({ byte_length: 999 }),
      sourceMeasurement({ path: 'src/other.ts', source_hash: sha256Utf8('export function loadOrder() {}') }),
    ]
    for (const measurement of cases) expect(() => computeRetrievalMetrics(retrievalRun({ measurements: [measurement] }))).toThrow(/measurement|source|path|hash|byte/i)
  })

  it('rejects overlapping duplicate source measurements for one path', () => {
    expect(() => computeRetrievalMetrics(retrievalRun({ measurements: [
      sourceMeasurement(),
      sourceMeasurement({ start_offset: 20, end_offset: 29, text: 'rder() {}', byte_length: 9 }),
    ] }))).toThrow(/overlap|measurement/i)
  })

  it('rejects identical zero-length source measurements', () => {
    const empty = sourceMeasurement({ start_offset: 0, end_offset: 0, text: '', byte_length: 0 })
    expect(() => computeRetrievalMetrics(retrievalRun({ run_mode: 'optimized', cache_condition: 'cold', uncached_source_tokens: 0, measurements: [empty, empty] }))).toThrow(/overlap|duplicate|measurement/i)
  })

  it('rejects a measurement path that has not been verified even when it is required', () => {
    const extendedTask = {
      ...task('metric-task'),
      verifier: { ...task('metric-task').verifier, required_paths: ['src/auth.ts', 'src/support.ts'] },
    }
    expect(() => computeRetrievalMetrics(retrievalRun({
      task: extendedTask,
      measurements: [sourceMeasurement({ path: 'src/support.ts' })],
    }))).toThrow(/not verified/i)
  })
})

describe('v0.2b promotion report aggregation boundary', () => {
  it('reports baseline-only v0.2a as not-ready without claiming reduction', () => {
    const report = evaluatePromotion(corpusRecords('baseline', 'none', 100))
    expect(report).toMatchObject<Partial<PromotionReportV1>>({
      task_count: 12,
      repository_shape_count: 3,
      aggregates: { cold: null, warm: null },
      passes: false,
      status: 'not-ready',
      failure_class: 'optimized_records_missing',
    })
  })

  it('requires exactly three records for each optimized cache condition and rejects duplicates', () => {
    const baseline = corpusRecords('baseline', 'none', 100)
    const cold = corpusRecords('optimized', 'cold', 70)
    const warm = corpusRecords('optimized', 'warm', 70)
    expect(evaluatePromotion([...baseline, ...cold.slice(0, -1), ...warm])).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
    expect(evaluatePromotion([...baseline, ...cold, ...warm, cold[0]])).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
  })

  it('computes separate cold and warm reductions and uses only successful uncached tokens', () => {
    const baseline = corpusRecords('baseline', 'none', 100)
    const cold = corpusRecords('optimized', 'cold', 70, { uncached_source_tokens: 40 })
    const warm = corpusRecords('optimized', 'warm', 60, { uncached_source_tokens: 20, oracle_success: false })
    const report = evaluatePromotion([...baseline, ...cold, ...warm])
    expect(report.aggregates.cold?.median_source_token_reduction).toBeCloseTo(0.3)
    expect(report.aggregates.warm?.median_source_token_reduction).toBeCloseTo(0.4)
    expect(report.aggregates.cold?.uncached_tokens_per_success).toBe(40)
    expect(report.aggregates.warm?.uncached_tokens_per_success).toBeNull()
  })

  it('rejects optimized records without a matching baseline or with a zero baseline median', () => {
    const baseline = corpusRecords('baseline', 'none', 100)
    const cold = corpusRecords('optimized', 'cold', 70)
    const warm = corpusRecords('optimized', 'warm', 70)
    expect(evaluatePromotion([...cold, ...warm])).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
    expect(evaluatePromotion([...corpusRecords('baseline', 'none', 0), ...cold, ...warm])).toMatchObject({ status: 'failed', failure_class: 'baseline_zero' })
  })

  it('fails promotion when either condition misses a threshold', () => {
    const baseline = corpusRecords('baseline', 'none', 100)
    const cold = corpusRecords('optimized', 'cold', 70)
    const warm = corpusRecords('optimized', 'warm', 99)
    const report = evaluatePromotion([...baseline, ...cold, ...warm])
    expect(report.status).toBe('failed')
    expect(report.failure_class).toBe('threshold_failed')
    expect(report.passes).toBe(false)
  })

  it('uses only fixed manifest task IDs and shapes for the corpus gate', () => {
    const baseline = corpusRecords('baseline', 'none', 100, {}, corpusTaskIds.map((taskId, index) => index === 0 ? `forged-small-${taskId}` : taskId))
    expect(evaluatePromotion(baseline)).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing', repository_shape_count: 0 })
    const optimized = corpusRecords('optimized', 'cold', 70)
    const warm = corpusRecords('optimized', 'warm', 70)
    expect(evaluatePromotion([...corpusRecords('baseline', 'none', 100), ...optimized, ...warm])).toMatchObject({ repository_shape_count: 3 })
  })

  it('round-trips evaluator output through the shared promotion parser', async () => {
    const { parsePromotionReportV1 } = await import('@ds-plugins/dsh-context')
    const baseline = corpusRecords('baseline', 'none', 100)
    const cold = corpusRecords('optimized', 'cold', 70, { uncached_source_tokens: 40 })
    const warm = corpusRecords('optimized', 'warm', 70, { uncached_source_tokens: 40 })
    const report = evaluatePromotion([...baseline, ...cold, ...warm])
    expect(report.status).toBe('passed')
    expect(parsePromotionReportV1(report)).toEqual(report)
  })

  it('classifies partial optimized input as invalid pairing rather than not-ready', () => {
    const baseline = corpusRecords('baseline', 'none', 100)
    const cold = corpusRecords('optimized', 'cold', 70)
    expect(evaluatePromotion([...baseline, ...cold])).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
  })

  it('classifies an incomplete baseline as invalid pairing before optimized absence', () => {
    const baseline = corpusRecords('baseline', 'none', 100)
    const incomplete = baseline.filter(record => !(record.task_id === corpusTaskIds[0] && record.run_index === 3))
    expect(evaluatePromotion(incomplete)).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
  })

  it('counts only oracle successes that also have passed verification', () => {
    const baseline = corpusRecords('baseline', 'none', 100)
    const cold = corpusRecords('optimized', 'cold', 70, { oracle_success: false, verification_status: 'passed' })
    const warm = corpusRecords('optimized', 'warm', 70)
    const contradictory = corpusRecords('optimized', 'warm', 70, { oracle_success: true, verification_status: 'failed' })
    expect(() => evaluatePromotion([...baseline, ...cold, ...warm.slice(0, -3), ...contradictory])).toThrow()
    const report = evaluatePromotion([...baseline, ...cold, ...warm])
    expect(report.aggregates.cold?.mean_oracle_success).toBe(0)
    expect(report.aggregates.cold?.uncached_tokens_per_success).toBeNull()
  })
})
