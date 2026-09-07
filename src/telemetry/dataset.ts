import {
  canonicalJson,
  parseRunAnnotationV1,
  parseTelemetryRecordV1,
  type DatasetV1,
  type ObservationV1,
  type RunAnnotationV1,
  type RunSealV1,
} from '@ds-plugins/dsh-telemetry/contracts'
import { Buffer } from 'node:buffer'

const MAX_TELEMETRY_BYTES = 8 * 1024 * 1024
const MAX_ANNOTATION_BYTES = 1024 * 1024
const MAX_RECORDS = 65_536
const MAX_ANNOTATIONS = 4_096

export type ValidatedCompleteRunV1 = {
  domainRef: string
  runRef: string
  observations: ObservationV1[]
  seal: RunSealV1
  annotation: RunAnnotationV1 | null
}

type ValidatedDataset = DatasetV1 & { completeRuns: ValidatedCompleteRunV1[] }

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function recordIdentity(record: ObservationV1 | RunSealV1): string {
  return record.kind === 'run-seal'
    ? `${record.domainRef}:${record.runRef}:seal`
    : `${record.domainRef}:${record.runRef}:observation:${record.seq}`
}

function runIdentity(domainRef: string, runRef: string): string {
  return `${domainRef}:${runRef}`
}

function addBounded(total: number, increment: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(increment) || increment < 0 || total > maximum - increment) {
    throw new TypeError(`${label} exceeds byte limit`)
  }
  return total + increment
}

function validateDataset(recordsInput: unknown[], annotationsInput: unknown[]): ValidatedDataset {
  if (!Array.isArray(recordsInput) || !Array.isArray(annotationsInput)) {
    throw new TypeError('dataset records and annotations must be arrays')
  }
  if (recordsInput.length > MAX_RECORDS) throw new TypeError(`dataset record count exceeds ${MAX_RECORDS}`)
  if (annotationsInput.length > MAX_ANNOTATIONS) throw new TypeError(`dataset annotation count exceeds ${MAX_ANNOTATIONS}`)

  const records: DatasetV1['records'] = []
  const recordsByIdentity = new Map<string, { canonical: string; record: DatasetV1['records'][number] }>()
  let telemetryBytes = 0
  for (const value of recordsInput) {
    const record = parseTelemetryRecordV1(value)
    const canonical = canonicalJson(record)
    telemetryBytes = addBounded(telemetryBytes, byteLength(canonical) + 1, MAX_TELEMETRY_BYTES, 'telemetry dataset')
    const identity = recordIdentity(record)
    const prior = recordsByIdentity.get(identity)
    if (prior !== undefined) {
      if (prior.canonical !== canonical) throw new TypeError(`conflicting telemetry record: ${identity}`)
      continue
    }
    recordsByIdentity.set(identity, { canonical, record })
    records.push(record)
  }

  const annotations: RunAnnotationV1[] = []
  const annotationsByRun = new Map<string, { canonical: string; annotation: RunAnnotationV1 }>()
  let annotationBytes = 2
  for (const value of annotationsInput) {
    const annotation = parseRunAnnotationV1(value)
    const canonical = canonicalJson(annotation)
    annotationBytes = addBounded(
      annotationBytes,
      byteLength(canonical) + (annotations.length === 0 ? 0 : 1),
      MAX_ANNOTATION_BYTES,
      'annotation dataset',
    )
    const identity = runIdentity(annotation.domainRef, annotation.runRef)
    const prior = annotationsByRun.get(identity)
    if (prior !== undefined) {
      if (prior.canonical !== canonical) throw new TypeError(`conflicting run annotation: ${identity}`)
      continue
    }
    annotationsByRun.set(identity, { canonical, annotation })
    annotations.push(annotation)
  }

  const observationsByRun = new Map<string, ObservationV1[]>()
  const sealsByRun = new Map<string, RunSealV1>()
  for (const record of records) {
    const identity = runIdentity(record.domainRef, record.runRef)
    if (record.kind === 'run-seal') sealsByRun.set(identity, record)
    else {
      const observations = observationsByRun.get(identity) ?? []
      observations.push(record)
      observationsByRun.set(identity, observations)
    }
  }

  for (const annotation of annotations) {
    const identity = runIdentity(annotation.domainRef, annotation.runRef)
    const observations = observationsByRun.get(identity) ?? []
    const ordinals = new Set(observations.map(observation => observation.seq))
    const resolve = (evidence: { runRef: string; seq: number }, path: string) => {
      if (evidence.runRef !== annotation.runRef) throw new TypeError(`${path} must reference the annotation run`)
      if (!ordinals.has(evidence.seq)) throw new TypeError(`${path} does not resolve to an observation in the annotation domain`)
    }
    annotation.evidence.forEach((evidence, index) => resolve(evidence, `annotation evidence[${index}]`))
    annotation.failure?.evidence.forEach((evidence, index) => resolve(evidence, `failure evidence[${index}]`))
  }

  const completeRuns: ValidatedCompleteRunV1[] = []
  const runIdentities = new Set([...observationsByRun.keys(), ...sealsByRun.keys()])
  for (const identity of runIdentities) {
    const observations = [...(observationsByRun.get(identity) ?? [])].sort((left, right) => left.seq - right.seq)
    const seal = sealsByRun.get(identity)
    if (seal === undefined || !seal.complete || seal.lostCount !== 0) continue
    if (seal.observationCount !== observations.length) continue
    if (observations.some((observation, index) => observation.seq !== index + 1)) continue
    const annotation = annotationsByRun.get(identity)?.annotation ?? null
    completeRuns.push({
      domainRef: seal.domainRef,
      runRef: seal.runRef,
      observations,
      seal,
      annotation,
    })
  }

  return { records, annotations, completeRuns }
}

/** Parse, bound, de-duplicate and cross-check one offline telemetry dataset. */
export function parseDatasetV1(records: unknown[], annotations: unknown[]): DatasetV1 {
  const validated = validateDataset(records, annotations)
  return { records: validated.records, annotations: validated.annotations }
}

/** Revalidate a dataset and return only sealed, lossless runs with ordinals 1..observationCount. */
export function getValidatedCompleteRunsV1(dataset: DatasetV1): ValidatedCompleteRunV1[] {
  return validateDataset(dataset.records, dataset.annotations).completeRuns
}
