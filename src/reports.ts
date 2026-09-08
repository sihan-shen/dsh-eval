import type { EvaluationRecordV1, PromotionAggregateV1, PromotionReportV1 } from '@han_05/dsh-context'
import { parseEvaluationRecordV1 } from '@han_05/dsh-context'
import { median } from './metrics.js'

const thresholds = {
  min_median_source_token_reduction: 0.25,
  min_mean_symbol_query_recall_at_5: 0.95,
  min_mean_target_coverage: 0.95,
  min_mean_oracle_success: 0.95,
} as const

const emptyAggregates = { cold: null, warm: null } as const
const checkedInCorpusTasks = new Map<string, 'ts-small' | 'ts-medium' | 'ts-layered'>([
  ['small-auth-load', 'ts-small'],
  ['small-auth-validate', 'ts-small'],
  ['small-service-create', 'ts-small'],
  ['small-types-user', 'ts-small'],
  ['medium-commands-register', 'ts-medium'],
  ['medium-commands-execute', 'ts-medium'],
  ['medium-registry-add', 'ts-medium'],
  ['medium-index-create', 'ts-medium'],
  ['layered-order-create', 'ts-layered'],
  ['layered-order-type', 'ts-layered'],
  ['layered-checkout-run', 'ts-layered'],
  ['layered-store-save', 'ts-layered'],
])

function failureReport(taskCount: number, shapeCount: number, failure_class: NonNullable<PromotionReportV1['failure_class']>): PromotionReportV1 {
  return {
    schema_version: 1,
    corpus_id: 'dsh-v0.2a-fixture-corpus',
    task_count: taskCount,
    repository_shape_count: shapeCount,
    thresholds,
    aggregates: emptyAggregates,
    passes: false,
    status: failure_class === 'optimized_records_missing' ? 'not-ready' : 'failed',
    failure_class,
  }
}

function aggregateForCondition(baselineByTask: Map<string, EvaluationRecordV1[]>, optimizedByTask: Map<string, EvaluationRecordV1[]>): PromotionAggregateV1 {
  const reductions: number[] = []
  const recalls: number[] = []
  const coverages: number[] = []
  const oracles: number[] = []
  const successfulUncached: number[] = []
  for (const [taskId, baseline] of baselineByTask) {
    const optimized = optimizedByTask.get(taskId) ?? []
    const baselineMedian = median(baseline.map(record => record.source_token_estimate))
    const optimizedMedian = median(optimized.map(record => record.source_token_estimate))
    reductions.push((baselineMedian - optimizedMedian) / baselineMedian)
    recalls.push(median(optimized.map(record => record.symbol_query_recall_at_5)))
    coverages.push(median(optimized.map(record => record.target_coverage)))
    const verifiedSuccess = (record: EvaluationRecordV1): boolean => record.oracle_success && record.verification_status === 'passed'
    oracles.push(median(optimized.map(record => verifiedSuccess(record) ? 1 : 0)))
    successfulUncached.push(...optimized.filter(verifiedSuccess).map(record => record.uncached_source_tokens))
  }
  return {
    median_source_token_reduction: median(reductions),
    uncached_tokens_per_success: successfulUncached.length === 0 ? null : median(successfulUncached),
    mean_symbol_query_recall_at_5: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
    mean_target_coverage: coverages.reduce((sum, value) => sum + value, 0) / coverages.length,
    mean_oracle_success: oracles.reduce((sum, value) => sum + value, 0) / oracles.length,
  }
}

export function evaluatePromotion(records: readonly EvaluationRecordV1[]): PromotionReportV1 {
  for (const record of records) parseEvaluationRecordV1(record)
  const taskIds = [...new Set(records.map(record => record.task_id))]
  const taskShapes = taskIds.map(taskId => checkedInCorpusTasks.get(taskId))
  const hasUnknownTask = taskShapes.some(shape => shape === undefined)
  const shapeCount = hasUnknownTask ? 0 : new Set(taskShapes).size
  if (taskIds.length < 12 || shapeCount < 3 || taskShapes.some(shape => shape === undefined)) return failureReport(taskIds.length, shapeCount, 'invalid_pairing')

  const groups = new Map<string, EvaluationRecordV1[]>()
  for (const record of records) {
    const key = `${record.task_id}|${record.run_mode}|${record.cache_condition}`
    const group = groups.get(key) ?? []
    if (group.some(item => item.run_index === record.run_index)) return failureReport(taskIds.length, shapeCount, 'invalid_pairing')
    group.push(record)
    groups.set(key, group)
  }
  const hasOptimizedRecords = records.some(record => record.run_mode === 'optimized')
  const baselineByTask = new Map<string, EvaluationRecordV1[]>()
  const coldByTask = new Map<string, EvaluationRecordV1[]>()
  const warmByTask = new Map<string, EvaluationRecordV1[]>()
  for (const taskId of taskIds) {
    const baseline = groups.get(`${taskId}|baseline|none`)
    if (!baseline || baseline.length !== 3) return failureReport(taskIds.length, shapeCount, 'invalid_pairing')
    baselineByTask.set(taskId, baseline)
  }
  if (!hasOptimizedRecords) return failureReport(taskIds.length, shapeCount, 'optimized_records_missing')
  for (const taskId of taskIds) {
    const baseline = baselineByTask.get(taskId)
    const cold = groups.get(`${taskId}|optimized|cold`)
    const warm = groups.get(`${taskId}|optimized|warm`)
    if (!baseline || !cold || cold.length !== 3 || !warm || warm.length !== 3) return failureReport(taskIds.length, shapeCount, 'invalid_pairing')
    coldByTask.set(taskId, cold)
    warmByTask.set(taskId, warm)
  }
  if (baselineByTask.size === 0) return failureReport(taskIds.length, shapeCount, 'optimized_records_missing')
  if (baselineByTask.size !== taskIds.length) return failureReport(taskIds.length, shapeCount, 'invalid_pairing')
  if ([...baselineByTask.values()].some(group => median(group.map(record => record.source_token_estimate)) === 0)) return failureReport(taskIds.length, shapeCount, 'baseline_zero')

  const cold = aggregateForCondition(baselineByTask, coldByTask)
  const warm = aggregateForCondition(baselineByTask, warmByTask)
  const passes = [cold, warm].every(aggregate =>
    (aggregate.median_source_token_reduction ?? -Infinity) >= thresholds.min_median_source_token_reduction &&
    (aggregate.mean_symbol_query_recall_at_5 ?? -Infinity) >= thresholds.min_mean_symbol_query_recall_at_5 &&
    (aggregate.mean_target_coverage ?? -Infinity) >= thresholds.min_mean_target_coverage &&
    (aggregate.mean_oracle_success ?? -Infinity) >= thresholds.min_mean_oracle_success,
  )
  return {
    schema_version: 1,
    corpus_id: 'dsh-v0.2a-fixture-corpus',
    task_count: taskIds.length,
    repository_shape_count: shapeCount,
    thresholds,
    aggregates: { cold, warm },
    passes,
    status: passes ? 'passed' : 'failed',
    ...(passes ? {} : { failure_class: 'threshold_failed' as const }),
  }
}
