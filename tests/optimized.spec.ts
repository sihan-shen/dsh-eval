import { afterEach, describe, expect, it } from 'vitest'
import { parseEvaluationRecordV1, type EvaluationTaskV1 } from '@han_05/dsh-context'
import manifest from '../fixtures/v0.2a/manifest.json'
import {
  createOptimizedCacheProtocol,
  runOptimized,
  type OptimizedCacheProtocol,
} from '../src/optimized.js'

const task = manifest.tasks[0] as EvaluationTaskV1
const protocols: OptimizedCacheProtocol[] = []

afterEach(async () => {
  await Promise.all(protocols.splice(0).map(protocol => protocol.dispose()))
})

describe('v0.2c optimized cache accounting', () => {
  it('reports a real miss for a fresh cold cache and real hits for prescribed warm runs', async () => {
    const protocol = await createOptimizedCacheProtocol()
    protocols.push(protocol)

    const cold = await runOptimized(task, 'cold', 1, protocol)
    const firstWarm = await runOptimized(task, 'warm', 1, protocol)
    const secondWarm = await runOptimized(task, 'warm', 2, protocol)

    for (const record of [cold, firstWarm, secondWarm]) {
      expect(parseEvaluationRecordV1(record)).toEqual(record)
      expect(record.symbol_query_recall_at_5).toBe(1)
      expect(record.target_coverage).toBe(1)
      expect(record.oracle_success).toBe(true)
    }
    expect(cold).toMatchObject({ cache_condition: 'cold', cache_hits: 0, cache_misses: 1 })
    expect(cold.uncached_source_tokens).toBe(cold.source_token_estimate)
    for (const warm of [firstWarm, secondWarm]) {
      expect(warm).toMatchObject({ cache_condition: 'warm', cache_hits: 1, cache_misses: 0 })
      expect(warm.uncached_source_tokens).toBe(0)
    }
  })

  it('keeps the provider-free v0.2b call contract uncached when no v0.2c protocol is supplied', async () => {
    const record = await runOptimized(task, 'warm', 1)
    expect(record).toMatchObject({ cache_hits: 0, cache_misses: 0 })
    expect(record.uncached_source_tokens).toBe(record.source_token_estimate)
  })
})
