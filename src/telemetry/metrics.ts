import type { DatasetV1, MetricV1, ObservationV1 } from '@han_05/dsh-telemetry/contracts'
import { getValidatedCompleteRunsV1 } from './dataset.js'

const unavailable = (): MetricV1 => ({
  value: null,
  numerator: 0,
  denominator: 0,
  observedRuns: 0,
  eligibleRuns: 0,
  basis: 'unavailable',
})

function metric(
  numerator: number,
  denominator: number,
  observedRuns: number,
  eligibleRuns: number,
  basis: 'observed' | 'estimated',
): MetricV1 {
  if (denominator === 0) return {
    value: null,
    numerator: 0,
    denominator: 0,
    observedRuns: 0,
    eligibleRuns,
    basis: 'unavailable',
  }
  return { value: numerator / denominator, numerator, denominator, observedRuns, eligibleRuns, basis }
}

function rootRoutes(observations: ObservationV1[]): string[] {
  return observations
    .filter(observation => observation.facts.scope === 'root' && observation.facts.routeRef !== undefined)
    .map(observation => observation.facts.routeRef as string)
}

/** Compute the fixed v0.5 inventory from revalidated complete runtime evidence. */
export function computeTelemetryMetrics(dataset: DatasetV1): Record<string, MetricV1> {
  const completeRuns = getValidatedCompleteRunsV1(dataset)
  const annotatedRuns = completeRuns.filter(run => run.annotation !== null)
  const knownOutcomes = annotatedRuns.filter(run => run.annotation?.outcome !== 'unknown')
  const explicitAcceptance = annotatedRuns.filter(run => typeof run.annotation?.accepted === 'boolean')

  let workerRequests = 0
  let workerRuns = 0
  let routeSwitches = 0
  let routeComparisons = 0
  let comparedRuns = 0
  let verificationDuration = 0
  let verificationRuns = 0
  let durationOverflow = false

  for (const run of completeRuns) {
    const requests = run.observations.filter(observation => observation.kind === 'worker-requested').length
    if (requests > 0) workerRuns += 1
    workerRequests += requests

    const routes = rootRoutes(run.observations)
    if (routes.length > 1) comparedRuns += 1
    for (let index = 1; index < routes.length; index += 1) {
      routeComparisons += 1
      if (routes[index] !== routes[index - 1]) routeSwitches += 1
    }

    const durations = run.observations
      .filter(observation => observation.kind === 'verification-finished' && observation.facts.durationMs !== undefined)
      .map(observation => observation.facts.durationMs as number)
    if (durations.length > 0) verificationRuns += 1
    for (const duration of durations) {
      if (verificationDuration > Number.MAX_SAFE_INTEGER - duration) durationOverflow = true
      else verificationDuration += duration
    }
  }

  const metrics: Record<string, MetricV1> = {
    task_success_rate: metric(
      knownOutcomes.filter(run => run.annotation?.outcome === 'success').length,
      knownOutcomes.length,
      knownOutcomes.length,
      annotatedRuns.length,
      'observed',
    ),
    accepted_result_rate: metric(
      explicitAcceptance.filter(run => run.annotation?.accepted === true).length,
      explicitAcceptance.length,
      explicitAcceptance.length,
      annotatedRuns.length,
      'observed',
    ),
    worker_spawn_rate: metric(workerRequests, completeRuns.length, workerRuns, completeRuns.length, 'estimated'),
    model_switch_rate: metric(routeSwitches, routeComparisons, comparedRuns, completeRuns.length, 'observed'),
    verification_cost: durationOverflow
      ? unavailable()
      : metric(verificationDuration, verificationRuns, verificationRuns, completeRuns.length, 'observed'),
    cache_hit_ratio: unavailable(),
    uncached_tokens_per_success: unavailable(),
    source_token_estimate: unavailable(),
    uncached_source_tokens: unavailable(),
    lsp_to_source_ratio: unavailable(),
    worker_reuse_rate: unavailable(),
    retry_rate: unavailable(),
    latency_per_success: unavailable(),
    fallback_rate: unavailable(),
  }
  return metrics
}
