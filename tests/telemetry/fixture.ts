import type {
  EventKindV1,
  ObservationV1,
  RunAnnotationV1,
  RunSealV1,
  TelemetryRecordV1,
} from '@han_05/dsh-telemetry/contracts'

export const ref = (digit: string): string => digit.repeat(64)

export function observation(
  runRef: string,
  seq: number,
  kind: EventKindV1 = 'run-started',
  overrides: Partial<ObservationV1> = {},
): ObservationV1 {
  const facts: ObservationV1['facts'] = kind === 'run-started'
    ? { routeRef: ref('a'), scope: 'root' }
    : kind === 'schedule-selected'
      ? { routeRef: ref('a'), scope: 'root' }
      : kind === 'worker-requested'
        ? { scope: 'worker' }
        : kind === 'worker-finished'
          ? { scope: 'worker', status: 'completed' }
          : kind === 'budget-rejected'
            ? { status: 'budget-rejected' }
            : kind === 'verification-finished'
              ? { status: 'passed', durationMs: 10 }
              : kind === 'parallel-started'
                ? { fanoutRef: ref('b'), scope: 'dag' }
                : { fanoutRef: ref('b'), scope: 'dag', status: 'completed' }
  return {
    schemaVersion: 1,
    domainRef: ref('d'),
    runRef,
    sessionRef: ref('e'),
    seq,
    kind,
    observedAtMs: seq,
    facts,
    ...overrides,
  }
}

export function seal(runRef: string, observationCount: number, overrides: Partial<RunSealV1> = {}): RunSealV1 {
  return {
    schemaVersion: 1,
    kind: 'run-seal',
    domainRef: ref('d'),
    runRef,
    observationCount,
    lostCount: 0,
    complete: true,
    ...overrides,
  }
}

export function annotation(runRef: string, overrides: Partial<RunAnnotationV1> = {}): RunAnnotationV1 {
  return {
    schemaVersion: 1,
    domainRef: ref('d'),
    runRef,
    taskInstanceRef: ref('1'),
    taskFamilyRef: ref('2'),
    configHash: ref('3'),
    promptHash: ref('4'),
    outcome: 'success',
    accepted: true,
    failure: null,
    evidence: [{ runRef, seq: 1 }],
    ...overrides,
  }
}

export function completeRun(
  runRef: string,
  observations: ObservationV1[],
  runAnnotation: RunAnnotationV1 = annotation(runRef),
): { records: TelemetryRecordV1[]; annotation: RunAnnotationV1 } {
  return { records: [...observations, seal(runRef, observations.length)], annotation: runAnnotation }
}
