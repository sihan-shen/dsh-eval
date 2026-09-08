import {
  canonicalJson,
  type DatasetV1,
  type EvidenceRefV1,
  type RefV1,
} from '@han_05/dsh-telemetry/contracts'
import { getValidatedCompleteRunsV1 } from './dataset.js'

const MAX_COHORT_RUNS = 32

export type CalibrationV1 = {
  schemaVersion: 1
  domainRef: RefV1
  taskFamilyRef: RefV1
  configHash: RefV1
  promptHash: RefV1
  routeRef: RefV1
  samples: number
  successes: number
  successRate: number | null
  interval95: [number, number] | null
  sufficient: boolean
  evidence: EvidenceRefV1[]
}

type Sample = {
  runRef: RefV1
  success: boolean
  evidence: EvidenceRefV1
}

type Cohort = Pick<CalibrationV1, 'domainRef' | 'taskFamilyRef' | 'configHash' | 'promptHash' | 'routeRef'> & {
  samples: Map<RefV1, Sample>
}

function wilson95(successes: number, samples: number): [number, number] {
  const z = 1.96
  const p = successes / samples
  const divisor = 1 + z * z / samples
  const center = (p + z * z / (2 * samples)) / divisor
  const half = z * Math.sqrt(p * (1 - p) / samples + z * z / (4 * samples * samples)) / divisor
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

/** Summarize bounded, cohort-local outcomes for runs that observed exactly one root route. */
export function calibrateModels(dataset: DatasetV1): CalibrationV1[] {
  const cohorts = new Map<string, Cohort>()
  for (const run of getValidatedCompleteRunsV1(dataset)) {
    const annotation = run.annotation
    if (annotation === null || annotation.outcome === 'unknown') continue
    const rootRouteObservations = run.observations.filter(
      observation => observation.facts.scope === 'root' && observation.facts.routeRef !== undefined,
    )
    const routeRefs = new Set(rootRouteObservations.map(observation => observation.facts.routeRef as string))
    if (routeRefs.size !== 1) continue
    const routeRef = [...routeRefs][0]
    const provenance = rootRouteObservations[0]
    if (provenance === undefined) continue
    const key = canonicalJson([
      annotation.domainRef,
      annotation.taskFamilyRef,
      annotation.configHash,
      annotation.promptHash,
      routeRef,
    ])
    const cohort = cohorts.get(key) ?? {
      domainRef: annotation.domainRef,
      taskFamilyRef: annotation.taskFamilyRef,
      configHash: annotation.configHash,
      promptHash: annotation.promptHash,
      routeRef,
      samples: new Map<RefV1, Sample>(),
    }
    cohort.samples.set(run.runRef, {
      runRef: run.runRef,
      success: annotation.outcome === 'success',
      evidence: { runRef: run.runRef, seq: provenance.seq },
    })
    cohorts.set(key, cohort)
  }

  const reports: CalibrationV1[] = []
  for (const cohort of cohorts.values()) {
    const selected = [...cohort.samples.values()]
      .sort((left, right) => left.runRef.localeCompare(right.runRef))
      .slice(0, MAX_COHORT_RUNS)
    const samples = selected.length
    const successes = selected.filter(sample => sample.success).length
    reports.push({
      schemaVersion: 1,
      domainRef: cohort.domainRef,
      taskFamilyRef: cohort.taskFamilyRef,
      configHash: cohort.configHash,
      promptHash: cohort.promptHash,
      routeRef: cohort.routeRef,
      samples,
      successes,
      successRate: samples === 0 ? null : successes / samples,
      interval95: samples === 0 ? null : wilson95(successes, samples),
      sufficient: samples >= 3,
      evidence: selected.map(sample => sample.evidence),
    })
  }
  return reports.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
}
