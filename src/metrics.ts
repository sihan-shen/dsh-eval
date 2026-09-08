import type { EvaluationRecordV1, EvaluationTaskV1 } from '@han_05/dsh-context'
import { parseEvaluationTaskV1, sha256Utf8 } from '@han_05/dsh-context'
import { estimateSourceTokensV1, tokenizerMetadataV1 } from './tokenizer.js'
import type { BaselineFileV1, RetrievalRunV1, SourceMeasurementV1 } from './types.js'

function assertSourceBinding(run: RetrievalRunV1, task: EvaluationTaskV1): readonly SourceMeasurementV1[] {
  if (!Array.isArray(run.files)) throw new TypeError('source binding requires verified files')
  const filePaths = new Set<string>()
  const verifiedFiles = new Map<string, BaselineFileV1>()
  for (const file of run.files as readonly BaselineFileV1[]) {
    if (filePaths.has(file.path)) throw new TypeError('source binding contains duplicate file paths')
    if (!task.verifier.required_paths.includes(file.path)) throw new TypeError(`verified file is not required: ${file.path}`)
    if (sha256Utf8(file.text) !== file.content_hash) throw new TypeError(`verified file hash mismatch for ${file.path}`)
    if (new TextEncoder().encode(file.text).byteLength !== file.byte_length) throw new TypeError(`verified file byte length mismatch for ${file.path}`)
    filePaths.add(file.path)
    verifiedFiles.set(file.path, file)
  }
  if (run.source_text !== undefined) {
    const sourcePaths = Object.keys(run.source_text)
    if (sourcePaths.length !== filePaths.size || sourcePaths.some(path => !filePaths.has(path))) throw new TypeError('source binding paths mismatch')
    for (const file of run.files) {
      if (run.source_text[file.path] !== file.text) throw new TypeError(`source binding mismatch for ${file.path}`)
    }
  }
  const measurements = run.measurements ?? run.files.map(file => ({
    path: file.path,
    source_hash: file.content_hash,
    start_offset: 0,
    end_offset: file.text.length,
    text: file.text,
    byte_length: file.byte_length,
  }))
  const rangesByPath = new Map<string, Array<{ start: number; end: number }>>()
  for (const measurement of measurements) {
    if (!task.verifier.required_paths.includes(measurement.path)) throw new TypeError(`measurement path is not required: ${measurement.path}`)
    const file = verifiedFiles.get(measurement.path)
    if (file === undefined) throw new TypeError(`measurement file is not verified: ${measurement.path}`)
    if (measurement.source_hash !== file.content_hash) throw new TypeError(`measurement hash mismatch for ${measurement.path}`)
    if (!Number.isSafeInteger(measurement.start_offset) || !Number.isSafeInteger(measurement.end_offset) || measurement.start_offset < 0 || measurement.end_offset < measurement.start_offset || measurement.end_offset > file.text.length) {
      throw new TypeError(`measurement range is invalid for ${measurement.path}`)
    }
    const extracted = file.text.slice(measurement.start_offset, measurement.end_offset)
    if (measurement.text !== extracted) throw new TypeError(`measurement text mismatch for ${measurement.path}`)
    if (new TextEncoder().encode(measurement.text).byteLength !== measurement.byte_length) throw new TypeError(`measurement byte length mismatch for ${measurement.path}`)
    const ranges = rangesByPath.get(measurement.path) ?? []
    if (ranges.some(range =>
      (measurement.start_offset === range.start && measurement.end_offset === range.end) ||
      (measurement.start_offset < range.end && range.start < measurement.end_offset))) {
      throw new TypeError(`overlapping source measurements for ${measurement.path}`)
    }
    ranges.push({ start: measurement.start_offset, end: measurement.end_offset })
    rangesByPath.set(measurement.path, ranges)
  }
  if (run.run_mode === 'baseline' && run.measurements !== undefined) {
    if (measurements.length !== filePaths.size || measurements.some(measurement => {
      const file = verifiedFiles.get(measurement.path)
      return file === undefined || measurement.start_offset !== 0 || measurement.end_offset !== file.text.length
    })) throw new TypeError('baseline measurements must contain one full-file measurement per verified file')
  }
  return measurements
}

function sourceFileForPath(run: RetrievalRunV1, path: string): BaselineFileV1 | undefined {
  return run.files.find(file => file.path === path)
}

function validRange(text: string, start: { line: number; column: number }, end: { line: number; column: number }): boolean {
  if (start.line < 1 || end.line < start.line || (end.line === start.line && end.column < start.column)) return false
  const lines = text.split('\n')
  if (start.line > lines.length || end.line > lines.length) return false
  if (start.column > lines[start.line - 1].length || end.column > lines[end.line - 1].length) return false
  return true
}

function rangeText(text: string, start: { line: number; column: number }, end: { line: number; column: number }): string | null {
  if (!validRange(text, start, end)) return null
  const lines = text.split('\n')
  const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column
  return text.slice(offset(start.line, start.column), offset(end.line, end.column))
}

function isRelevant(run: RetrievalRunV1, task: EvaluationTaskV1, result: { path: string; name: string; sourceHash: string; start: { line: number; column: number }; end: { line: number; column: number } }): boolean {
  const file = sourceFileForPath(run, result.path)
  return task.target_symbols.some(target => target.path === result.path && target.name === result.name) &&
    task.verifier.required_paths.includes(result.path) &&
    file !== undefined &&
    validRange(file.text, result.start, result.end) &&
    rangeText(file.text, result.start, result.end) === result.name &&
    file.content_hash === result.sourceHash
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function computeRetrievalMetrics(run: RetrievalRunV1): EvaluationRecordV1 {
  const task = parseEvaluationTaskV1(run.task)
  const measurements = assertSourceBinding(run, task)
  const validResults = run.ranked_results.filter(result => isRelevant(run, task, result))
  const topFive = run.ranked_results.slice(0, 5)
  const relevantTopFive = new Set(topFive.filter(result => isRelevant(run, task, result)).map(result => `${result.path}:${result.name}`))
  const targetKeys = new Set(task.target_symbols.map(target => `${target.path}:${target.name}`))
  const coveredTargets = new Set(validResults.map(result => `${result.path}:${result.name}`)).size
  const targetCoverage = targetKeys.size === 0 ? 0 : coveredTargets / targetKeys.size
  const precision = run.ranked_results.length === 0 ? 0 : validResults.length / run.ranked_results.length
  const firstRelevantIndex = run.ranked_results.findIndex(result => isRelevant(run, task, result))
  const mrr = firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1)
  const recallAt5 = targetKeys.size === 0 ? 0 : [...relevantTopFive].filter(key => targetKeys.has(key)).length / targetKeys.size
  const source = measurements.map(measurement => measurement.text).join('\n')
  const sourceTokenEstimate = estimateSourceTokensV1(source)
  let uncachedSourceTokens: number
  if (run.run_mode === 'baseline') {
    uncachedSourceTokens = sourceTokenEstimate
  } else {
    const optimizedUncachedTokens = run.uncached_source_tokens
    if (optimizedUncachedTokens === undefined || !Number.isSafeInteger(optimizedUncachedTokens) || optimizedUncachedTokens < 0) {
      throw new TypeError('optimized runs require a non-negative integer uncached_source_tokens value')
    }
    uncachedSourceTokens = optimizedUncachedTokens
  }
  const oracleSuccess = targetCoverage === 1 && run.revision === task.revision && run.verifier_result
  return {
    schema_version: 1,
    run_mode: run.run_mode,
    task_id: task.task_id,
    cache_condition: run.cache_condition,
    run_index: run.run_index,
    ...tokenizerMetadataV1,
    source_token_estimate: sourceTokenEstimate,
    uncached_source_tokens: uncachedSourceTokens,
    context_blocks_requested: run.context_blocks_requested,
    cache_hits: run.cache_hits,
    cache_misses: run.cache_misses,
    symbol_query_precision: precision,
    symbol_query_recall_at_5: recallAt5,
    symbol_query_mrr: mrr,
    target_coverage: targetCoverage,
    oracle_success: oracleSuccess,
    verification_status: run.verifier_result ? 'passed' : 'failed',
    ...(run.verifier_result ? {} : { failure_class: 'fixture_integrity_failed' }),
    duration_ms: run.duration_ms ?? 0,
  }
}

export { median }
