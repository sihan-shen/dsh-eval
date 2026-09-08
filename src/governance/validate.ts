import {
  FAILURE_CLASSES,
  parseRunAnnotationV1,
  parseTelemetryRecordV1,
  type CandidateV1,
  type EvidenceRefV1,
  type FailureClassV1,
  type LessonV1,
  type ObservationV1,
  type PatternV1,
  type RunAnnotationV1,
  type RunSealV1,
} from '@han_05/dsh-telemetry/contracts'
import { canonicalGovernanceJson, sha256Canonical } from './canonical.js'
import type {
  ArmMetricObservationV1,
  ArtifactRefV1,
  CandidateSupportRunV1,
  CandidateSupportV1,
  CorpusFixtureV1,
  CorpusManifestV1,
  DecisionRecordV1,
  DomainEvidenceRefV1,
  EvaluationArmV1,
  EvaluationEvidenceV1,
  EvaluationPairV1,
  EvaluationRunRefV1,
  EvaluatorPolicyRefV1,
  GovernanceEntryV1,
  GovernanceLedgerV1,
  GovernanceProposalV1,
  GovernanceSurfaceV1,
  MetricComparisonV1,
  OfflineEvidenceResolverInputV1,
  ResolvedRunEvidenceV1,
  TemplateArtifactV1,
} from './contracts.js'

type JsonRecord = Record<string, unknown>
type TupleValue = { fixtureId: string, fixtureRevision: string, pairingKey: string }
type RunValue = { domainRef: string, runRef: string }

const HASH = /^[0-9a-f]{64}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const METRICS = ['task_success_rate', 'accepted_result_rate', 'verification_cost'] as const
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const MAX_FIXTURES = 256
const MAX_OBSERVATIONS = 2_048
const MAX_SUPPORT_RUNS = 4_096
const MAX_RECORDS = 65_536
const MAX_TELEMETRY_BYTES = 8_388_608
const MAX_ANNOTATIONS = 4_096
const MAX_ANNOTATION_BYTES = 1_048_576
const MAX_RECORD_BYTES = 8_192
const encoder = new TextEncoder()

function fail(path: string, code: string): never {
  throw new TypeError(`governance validation ${path} ${code}`)
}

function validateWith<T>(value: unknown, parser: (value: unknown, path: string) => T, path: string): T {
  try {
    canonicalGovernanceJson(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const code = message.includes('accessor') ? 'accessor'
      : message.includes('non-enumerable') ? 'non-enumerable'
        : message.includes('symbol') ? 'symbol'
          : message.includes('sparse') ? 'sparse'
            : message.includes('array property') ? 'array-property'
              : message.includes('cyclic') ? 'cyclic'
                : message.includes('plain JSON') ? 'plain-object'
                  : message.includes('number') ? 'number'
                    : message.includes('nesting') ? 'depth'
                      : message.includes('node count') ? 'node-count'
                        : message.includes('field count') ? 'field-count'
                          : message.includes('UTF-8 length') ? 'string-length'
                            : message.includes('byte length') ? 'byte-length'
                              : 'json-value'
    fail(path, code)
  }
  return parser(value, path)
}

function exact(value: unknown, path: string, keys: readonly string[]): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'object')
  const record = value as JsonRecord
  const actual = Object.keys(record)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(path, 'keys')
  return record
}

function array(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'array')
  if (value.length < minimum || value.length > maximum) fail(path, 'length')
  return value
}

function literal<T extends string | number | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, 'literal')
  return expected
}

function choice<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, 'enum')
  return value as T
}

function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail(path, 'hash')
  return value
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(path, 'identifier')
  return value
}

function semver(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'semver')
  const match = SEMVER.exec(value)
  if (!match) fail(path, 'semver')
  for (const part of match.slice(1, 4)) {
    if (!part || !Number.isSafeInteger(Number(part))) fail(path, 'semver')
  }
  return value
}

function integer(value: unknown, path: string, maximum = MAX_SAFE, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, 'integer')
  }
  return value
}

function finite(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, 'number')
  }
  return value
}

function nullableHash(value: unknown, path: string): string | null {
  return value === null ? null : hash(value, path)
}

function same(left: unknown, right: unknown): boolean {
  return canonicalGovernanceJson(left) === canonicalGovernanceJson(right)
}

function tupleKey(value: TupleValue): string {
  return `${value.fixtureId}\u0000${value.fixtureRevision}\u0000${value.pairingKey}`
}

function runKey(value: RunValue): string {
  return `${value.domainRef}\u0000${value.runRef}`
}

function evidenceKey(value: { runRef: string, seq: number }): string {
  return `${value.runRef}\u0000${String(value.seq).padStart(16, '0')}`
}

function domainEvidenceKey(value: DomainEvidenceRefV1): string {
  return `${value.domainRef}\u0000${evidenceKey(value)}`
}

function assertStrictOrder<T>(values: readonly T[], key: (value: T) => string, path: string, duplicateCode = 'unique'): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = key(values[index - 1]!)
    const current = key(values[index]!)
    if (current === previous) fail(path, duplicateCode)
    if (current < previous) fail(path, 'order')
  }
}

function parseArtifactRef(value: unknown, path: string): ArtifactRefV1 {
  const input = exact(value, path, ['schemaVersion', 'surface', 'version', 'digest'])
  return {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    surface: choice(input.surface, ['template', 'routing', 'verification', 'kernel'] as const, `${path}.surface`),
    version: semver(input.version, `${path}.version`),
    digest: hash(input.digest, `${path}.digest`),
  }
}

function parseTemplateArtifact(value: unknown, path: string): TemplateArtifactV1 {
  const input = exact(value, path, ['schemaVersion', 'ref', 'configHash', 'promptHash', 'bindingDigest'])
  const schemaVersion = literal(input.schemaVersion, 1, `${path}.schemaVersion`)
  const ref = parseArtifactRef(input.ref, `${path}.ref`)
  if (ref.surface !== 'template') fail(`${path}.ref.surface`, 'literal')
  const result: TemplateArtifactV1 = {
    schemaVersion,
    ref: { ...ref, surface: 'template' },
    configHash: hash(input.configHash, `${path}.configHash`),
    promptHash: hash(input.promptHash, `${path}.promptHash`),
    bindingDigest: hash(input.bindingDigest, `${path}.bindingDigest`),
  }
  const { bindingDigest: _bindingDigest, ...body } = result
  if (result.bindingDigest !== sha256Canonical(body)) fail(`${path}.bindingDigest`, 'derived')
  return result
}

function parseCorpusFixture(value: unknown, path: string): CorpusFixtureV1 {
  const input = exact(value, path, [
    'fixtureId', 'fixtureRevision', 'pairingKey', 'baseDomainRef', 'variantDomainRef',
    'taskFamilyRef', 'taskInstanceRef', 'fixtureInputDigest',
  ])
  return {
    fixtureId: identifier(input.fixtureId, `${path}.fixtureId`),
    fixtureRevision: identifier(input.fixtureRevision, `${path}.fixtureRevision`),
    pairingKey: identifier(input.pairingKey, `${path}.pairingKey`),
    baseDomainRef: hash(input.baseDomainRef, `${path}.baseDomainRef`),
    variantDomainRef: hash(input.variantDomainRef, `${path}.variantDomainRef`),
    taskFamilyRef: hash(input.taskFamilyRef, `${path}.taskFamilyRef`),
    taskInstanceRef: hash(input.taskInstanceRef, `${path}.taskInstanceRef`),
    fixtureInputDigest: hash(input.fixtureInputDigest, `${path}.fixtureInputDigest`),
  }
}

function parseCorpusManifest(value: unknown, path: string): CorpusManifestV1 {
  const input = exact(value, path, ['schemaVersion', 'corpusId', 'corpusRevision', 'fixtures', 'corpusManifestDigest'])
  const fixtures = array(input.fixtures, `${path}.fixtures`, 1, MAX_FIXTURES)
    .map((item, index) => parseCorpusFixture(item, `${path}.fixtures[${index}]`))
  assertStrictOrder(fixtures, tupleKey, `${path}.fixtures`)
  const result: CorpusManifestV1 = {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    corpusId: literal(input.corpusId, 'template-offline-v1-corpus', `${path}.corpusId`),
    corpusRevision: literal(input.corpusRevision, '1', `${path}.corpusRevision`),
    fixtures,
    corpusManifestDigest: hash(input.corpusManifestDigest, `${path}.corpusManifestDigest`),
  }
  const { corpusManifestDigest: _digest, ...body } = result
  if (result.corpusManifestDigest !== sha256Canonical(body)) fail(`${path}.corpusManifestDigest`, 'derived')
  return result
}

function parseEvaluationRunRef(value: unknown, path: string): EvaluationRunRefV1 {
  const input = exact(value, path, ['domainRef', 'runRef', 'fixtureId', 'fixtureRevision', 'pairingKey'])
  return {
    domainRef: hash(input.domainRef, `${path}.domainRef`),
    runRef: hash(input.runRef, `${path}.runRef`),
    fixtureId: identifier(input.fixtureId, `${path}.fixtureId`),
    fixtureRevision: identifier(input.fixtureRevision, `${path}.fixtureRevision`),
    pairingKey: identifier(input.pairingKey, `${path}.pairingKey`),
  }
}

function parseRunRefs(value: unknown, path: string, maximum = MAX_FIXTURES): EvaluationRunRefV1[] {
  const result = array(value, path, 0, maximum).map((item, index) => parseEvaluationRunRef(item, `${path}[${index}]`))
  assertStrictOrder(result, tupleKey, path)
  const runs = new Set<string>()
  for (const item of result) {
    const key = runKey(item)
    if (runs.has(key)) fail(path, 'unique-run')
    runs.add(key)
  }
  return result
}

function parseMetric(value: unknown, path: string, expectedName: typeof METRICS[number]): ArmMetricObservationV1 {
  const input = exact(value, path, ['name', 'value', 'numerator', 'denominator', 'observedRuns', 'eligibleRuns', 'basis'])
  const name = literal(input.name, expectedName, `${path}.name`)
  const numerator = integer(input.numerator, `${path}.numerator`, name === 'verification_cost' ? MAX_SAFE : MAX_FIXTURES)
  const denominator = integer(input.denominator, `${path}.denominator`, MAX_FIXTURES)
  const observedRuns = integer(input.observedRuns, `${path}.observedRuns`, MAX_FIXTURES)
  const eligibleRuns = integer(input.eligibleRuns, `${path}.eligibleRuns`, MAX_FIXTURES)
  if (observedRuns > eligibleRuns) fail(`${path}.observedRuns`, 'derived')
  const basis = choice(input.basis, ['observed', 'estimated', 'unavailable'] as const, `${path}.basis`)
  let metricValue: number | null
  if (denominator === 0) {
    if (input.value !== null || numerator !== 0 || observedRuns !== 0 || basis !== 'unavailable') fail(path, 'unavailable-shape')
    metricValue = null
  } else {
    const maximum = name === 'verification_cost' ? MAX_SAFE : 1
    metricValue = finite(input.value, `${path}.value`, 0, maximum)
    if ((basis !== 'observed' && basis !== 'estimated')
      || metricValue !== numerator / denominator
      || observedRuns > eligibleRuns) fail(path, 'derived')
  }
  return { name, value: metricValue, numerator, denominator, observedRuns, eligibleRuns, basis }
}

function parseEvaluationArm(value: unknown, path: string): EvaluationArmV1 {
  const input = exact(value, path, [
    'artifact', 'corpusRevision', 'runs', 'fixtureRuns', 'resolvedRuns', 'completeRuns',
    'incompleteRuns', 'excludedRuns', 'metrics',
  ])
  const runs = parseRunRefs(input.runs, `${path}.runs`)
  const fixtureRuns = integer(input.fixtureRuns, `${path}.fixtureRuns`, MAX_FIXTURES)
  const resolvedRuns = integer(input.resolvedRuns, `${path}.resolvedRuns`, MAX_FIXTURES)
  const completeRuns = integer(input.completeRuns, `${path}.completeRuns`, MAX_FIXTURES)
  const incompleteRuns = integer(input.incompleteRuns, `${path}.incompleteRuns`, MAX_FIXTURES)
  const excludedRuns = integer(input.excludedRuns, `${path}.excludedRuns`, MAX_FIXTURES)
  if (runs.length !== resolvedRuns) fail(`${path}.resolvedRuns`, 'derived')
  if (completeRuns > resolvedRuns || resolvedRuns > fixtureRuns) fail(path, 'count-order')
  if (incompleteRuns !== fixtureRuns - completeRuns) fail(`${path}.incompleteRuns`, 'derived')
  if (excludedRuns !== 0) fail(`${path}.excludedRuns`, 'derived')
  const metricsInput = array(input.metrics, `${path}.metrics`, METRICS.length, METRICS.length)
  const metrics = METRICS.map((name, index) => parseMetric(metricsInput[index], `${path}.metrics[${index}]`, name))
  for (let index = 0; index < metrics.length; index += 1) {
    const metric = metrics[index]!
    if (metric.name !== 'verification_cost' || metric.eligibleRuns !== 0 || metric.basis !== 'unavailable') {
      if (metric.eligibleRuns !== completeRuns) fail(`${path}.metrics[${index}].eligibleRuns`, 'derived')
    }
  }
  return {
    artifact: parseTemplateArtifact(input.artifact, `${path}.artifact`),
    corpusRevision: literal(input.corpusRevision, '1', `${path}.corpusRevision`),
    runs,
    fixtureRuns,
    resolvedRuns,
    completeRuns,
    incompleteRuns,
    excludedRuns,
    metrics,
  }
}

function parseStandaloneMetric(value: unknown, path: string): ArmMetricObservationV1 {
  const input = exact(value, path, ['name', 'value', 'numerator', 'denominator', 'observedRuns', 'eligibleRuns', 'basis'])
  const name = choice(input.name, METRICS, `${path}.name`)
  return parseMetric(input, path, name)
}

function parseEvaluationPair(value: unknown, path: string): EvaluationPairV1 {
  const input = exact(value, path, ['fixtureId', 'fixtureRevision', 'pairingKey', 'baseRun', 'variantRun'])
  const result: EvaluationPairV1 = {
    fixtureId: identifier(input.fixtureId, `${path}.fixtureId`),
    fixtureRevision: identifier(input.fixtureRevision, `${path}.fixtureRevision`),
    pairingKey: identifier(input.pairingKey, `${path}.pairingKey`),
    baseRun: parseEvaluationRunRef(input.baseRun, `${path}.baseRun`),
    variantRun: parseEvaluationRunRef(input.variantRun, `${path}.variantRun`),
  }
  for (const side of ['baseRun', 'variantRun'] as const) {
    if (tupleKey(result[side]) !== tupleKey(result)) fail(`${path}.${side}`, 'tuple')
  }
  if (runKey(result.baseRun) === runKey(result.variantRun)) fail(path, 'unique-run')
  return result
}

function parseObservation(value: unknown, path: string): ObservationV1 {
  let parsed: ReturnType<typeof parseTelemetryRecordV1>
  try {
    parsed = parseTelemetryRecordV1(value)
  } catch {
    fail(path, 'telemetry')
  }
  if (parsed.kind === 'run-seal') fail(path, 'observation')
  integer(parsed.seq, `${path}.seq`, MAX_OBSERVATIONS, 1)
  return parsed
}

function parseSeal(value: unknown, path: string): RunSealV1 {
  let parsed: ReturnType<typeof parseTelemetryRecordV1>
  try {
    parsed = parseTelemetryRecordV1(value)
  } catch {
    fail(path, 'telemetry')
  }
  if (parsed.kind !== 'run-seal') fail(path, 'seal')
  integer(parsed.observationCount, `${path}.observationCount`, MAX_OBSERVATIONS)
  return parsed
}

function parseAnnotation(value: unknown, path: string): RunAnnotationV1 {
  try {
    return parseRunAnnotationV1(value)
  } catch {
    fail(path, 'annotation')
  }
}

function parseObservations(value: unknown, path: string): ObservationV1[] {
  const result = array(value, path, 0, MAX_OBSERVATIONS).map((item, index) => parseObservation(item, `${path}[${index}]`))
  for (let index = 1; index < result.length; index += 1) {
    if (result[index]!.seq <= result[index - 1]!.seq) fail(path, 'order')
  }
  return result
}

function parseResolvedRun(value: unknown, path: string): ResolvedRunEvidenceV1 {
  const input = exact(value, path, ['ref', 'observations', 'seal', 'annotation'])
  const ref = parseEvaluationRunRef(input.ref, `${path}.ref`)
  const observations = parseObservations(input.observations, `${path}.observations`)
  const seal = input.seal === null ? null : parseSeal(input.seal, `${path}.seal`)
  const annotation = input.annotation === null ? null : parseAnnotation(input.annotation, `${path}.annotation`)
  for (const observation of observations) {
    if (observation.domainRef !== ref.domainRef || observation.runRef !== ref.runRef) fail(`${path}.observations`, 'identity')
  }
  if (seal && (seal.domainRef !== ref.domainRef || seal.runRef !== ref.runRef)) fail(`${path}.seal`, 'identity')
  if (annotation && (annotation.domainRef !== ref.domainRef || annotation.runRef !== ref.runRef)) fail(`${path}.annotation`, 'identity')
  if (annotation) {
    const sequences = new Set(observations.map(item => item.seq))
    const resolves = (items: readonly EvidenceRefV1[]): boolean => items.every(item => item.runRef === ref.runRef && sequences.has(item.seq))
    if (!resolves(annotation.evidence) || (annotation.failure && !resolves(annotation.failure.evidence))) {
      fail(`${path}.annotation`, 'evidence')
    }
  }
  return { ref, observations, seal, annotation }
}

function parseResolvedRuns(value: unknown, path: string, maximum: number): ResolvedRunEvidenceV1[] {
  const result = array(value, path, 0, maximum).map((item, index) => parseResolvedRun(item, `${path}[${index}]`))
  assertStrictOrder(result, item => tupleKey(item.ref), path)
  const runs = new Set<string>()
  for (const item of result) {
    const key = runKey(item.ref)
    if (runs.has(key)) fail(path, 'unique-run')
    runs.add(key)
  }
  return result
}

function parseResolverInput(value: unknown, path: string): OfflineEvidenceResolverInputV1 {
  const input = exact(value, path, ['schemaVersion', 'corpusManifest', 'baseArtifact', 'variantArtifact', 'baseRuns', 'variantRuns'])
  const corpusManifest = parseCorpusManifest(input.corpusManifest, `${path}.corpusManifest`)
  const baseArtifact = parseTemplateArtifact(input.baseArtifact, `${path}.baseArtifact`)
  const variantArtifact = parseTemplateArtifact(input.variantArtifact, `${path}.variantArtifact`)
  const baseRuns = parseResolvedRuns(input.baseRuns, `${path}.baseRuns`, corpusManifest.fixtures.length)
  const variantRuns = parseResolvedRuns(input.variantRuns, `${path}.variantRuns`, corpusManifest.fixtures.length)
  const fixtureByTuple = new Map(corpusManifest.fixtures.map(fixture => [tupleKey(fixture), fixture]))
  const allRuns = new Set<string>()
  for (const [side, runs, artifact] of [
    ['base', baseRuns, baseArtifact],
    ['variant', variantRuns, variantArtifact],
  ] as const) {
    for (const run of runs) {
      const key = runKey(run.ref)
      if (allRuns.has(key)) fail(`${path}.${side}Runs`, 'cross-arm-run')
      allRuns.add(key)
      const fixture = fixtureByTuple.get(tupleKey(run.ref))
      if (!fixture) fail(`${path}.${side}Runs`, 'fixture')
      const expectedDomain = side === 'base' ? fixture.baseDomainRef : fixture.variantDomainRef
      if (run.ref.domainRef !== expectedDomain) fail(`${path}.${side}Runs`, 'domain')
      if (run.annotation) {
        if (run.annotation.taskFamilyRef !== fixture.taskFamilyRef
          || run.annotation.taskInstanceRef !== fixture.taskInstanceRef
          || run.annotation.configHash !== artifact.configHash
          || run.annotation.promptHash !== artifact.promptHash) fail(`${path}.${side}Runs`, 'annotation-binding')
      }
    }
  }
  const result = { schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`), corpusManifest, baseArtifact, variantArtifact, baseRuns, variantRuns }
  assertTelemetryBudget([...baseRuns, ...variantRuns], path)
  return result
}

function parsePolicy(value: unknown, path: string): EvaluatorPolicyRefV1 {
  const input = exact(value, path, ['policyId', 'policyRevision', 'policyDigest'])
  return {
    policyId: literal(input.policyId, 'template-offline-v1', `${path}.policyId`),
    policyRevision: literal(input.policyRevision, 1, `${path}.policyRevision`),
    policyDigest: hash(input.policyDigest, `${path}.policyDigest`),
  }
}

function parseComparison(value: unknown, path: string, expectedName: typeof METRICS[number]): MetricComparisonV1 {
  const input = exact(value, path, ['name', 'baseValue', 'variantValue', 'delta', 'result'])
  const name = literal(input.name, expectedName, `${path}.name`)
  const result = choice(input.result, ['pass', 'fail', 'unavailable'] as const, `${path}.result`)
  if (result === 'unavailable') {
    if (input.baseValue !== null || input.variantValue !== null || input.delta !== null) fail(path, 'unavailable-shape')
    return { name, baseValue: null, variantValue: null, delta: null, result }
  }
  const valueMaximum = name === 'verification_cost' ? MAX_SAFE : 1
  const deltaMaximum = name === 'verification_cost' ? MAX_SAFE : 1
  const parsed = {
    name,
    baseValue: finite(input.baseValue, `${path}.baseValue`, 0, valueMaximum),
    variantValue: finite(input.variantValue, `${path}.variantValue`, 0, valueMaximum),
    delta: finite(input.delta, `${path}.delta`, -deltaMaximum, deltaMaximum),
    result,
  }
  if (parsed.delta !== parsed.variantValue - parsed.baseValue) fail(`${path}.delta`, 'derived')
  const expectedResult = name === 'verification_cost'
    ? parsed.variantValue <= parsed.baseValue * 1.1 ? 'pass' : 'fail'
    : parsed.delta >= 0 ? 'pass' : 'fail'
  if (parsed.result !== expectedResult) fail(`${path}.result`, 'derived')
  return parsed
}

function completeRun(run: ResolvedRunEvidenceV1): boolean {
  if (!run.seal || !run.annotation || !run.seal.complete || run.seal.lostCount !== 0) return false
  if (run.seal.observationCount !== run.observations.length) return false
  return run.observations.every((observation, index) => observation.seq === index + 1)
}

function deriveMetrics(runs: readonly ResolvedRunEvidenceV1[]): EvaluationArmV1['metrics'] {
  const complete = runs.filter(completeRun)
  let known = 0
  let successes = 0
  let explicitAcceptance = 0
  let accepted = 0
  let cost = 0
  let costRuns = 0
  let overflow = false
  for (const run of complete) {
    const annotation = run.annotation!
    if (annotation.outcome !== 'unknown') {
      known += 1
      if (annotation.outcome === 'success') successes += 1
    }
    if (annotation.accepted !== null) {
      explicitAcceptance += 1
      if (annotation.accepted) accepted += 1
    }
    let hasDuration = false
    for (const observation of run.observations) {
      if (observation.kind === 'verification-finished' && observation.facts.durationMs !== undefined) {
        hasDuration = true
        if (cost > MAX_SAFE - observation.facts.durationMs) overflow = true
        else if (!overflow) cost += observation.facts.durationMs
      }
    }
    if (hasDuration) costRuns += 1
  }
  const rate = (name: typeof METRICS[0] | typeof METRICS[1], numerator: number, denominator: number): ArmMetricObservationV1 => denominator === 0
    ? { name, value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: complete.length, basis: 'unavailable' }
    : { name, value: numerator / denominator, numerator, denominator, observedRuns: denominator, eligibleRuns: complete.length, basis: 'observed' }
  const costMetric: ArmMetricObservationV1 = overflow
    ? { name: 'verification_cost', value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 0, basis: 'unavailable' }
    : costRuns === 0
      ? { name: 'verification_cost', value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: complete.length, basis: 'unavailable' }
      : { name: 'verification_cost', value: cost / costRuns, numerator: cost, denominator: costRuns, observedRuns: costRuns, eligibleRuns: complete.length, basis: 'observed' }
  return [rate('task_success_rate', successes, known), rate('accepted_result_rate', accepted, explicitAcceptance), costMetric]
}

function deriveComparisons(base: EvaluationArmV1, variant: EvaluationArmV1): MetricComparisonV1[] {
  const minimumCoverage = (name: typeof METRICS[number]): number => name === 'verification_cost' ? 0.8 : 1
  const available = (metric: ArmMetricObservationV1, name: typeof METRICS[number]): boolean => (
    metric.value !== null
    && metric.basis === 'observed'
    && metric.eligibleRuns > 0
    && metric.observedRuns / metric.eligibleRuns >= minimumCoverage(name)
  )
  return METRICS.map((name, index) => {
    const baseMetric = base.metrics[index]!
    const variantMetric = variant.metrics[index]!
    if (!available(baseMetric, name) || !available(variantMetric, name)) {
      return { name, baseValue: null, variantValue: null, delta: null, result: 'unavailable' }
    }
    const baseValue = baseMetric.value
    const variantValue = variantMetric.value
    if (baseValue === null || variantValue === null) {
      return { name, baseValue: null, variantValue: null, delta: null, result: 'unavailable' }
    }
    const delta = variantValue - baseValue
    const passed = name === 'verification_cost'
      ? variantValue <= baseValue * 1.1
      : delta >= 0
    return { name, baseValue, variantValue, delta, result: passed ? 'pass' : 'fail' }
  })
}

function parseEvaluationEvidence(value: unknown, path: string): EvaluationEvidenceV1 {
  const input = exact(value, path, [
    'schemaVersion', 'policy', 'corpusId', 'corpusRevision', 'corpusManifestDigest', 'resolverInput',
    'baseArm', 'variantArm', 'pairs', 'comparisons', 'result',
  ])
  const resolverInput = parseResolverInput(input.resolverInput, `${path}.resolverInput`)
  const baseArm = parseEvaluationArm(input.baseArm, `${path}.baseArm`)
  const variantArm = parseEvaluationArm(input.variantArm, `${path}.variantArm`)
  if (input.corpusId !== resolverInput.corpusManifest.corpusId) fail(`${path}.corpusId`, 'derived')
  if (input.corpusRevision !== resolverInput.corpusManifest.corpusRevision) fail(`${path}.corpusRevision`, 'derived')
  if (input.corpusManifestDigest !== resolverInput.corpusManifest.corpusManifestDigest) fail(`${path}.corpusManifestDigest`, 'derived')
  if (!same(baseArm.artifact, resolverInput.baseArtifact)) fail(`${path}.baseArm.artifact`, 'derived')
  if (!same(variantArm.artifact, resolverInput.variantArtifact)) fail(`${path}.variantArm.artifact`, 'derived')
  const fixtureCount = resolverInput.corpusManifest.fixtures.length
  const sides = [[baseArm, resolverInput.baseRuns, 'baseArm'], [variantArm, resolverInput.variantRuns, 'variantArm']] as const
  for (const [arm, runs, label] of sides) {
    const refs = runs.map(run => run.ref)
    if (arm.fixtureRuns !== fixtureCount) fail(`${path}.${label}.fixtureRuns`, 'derived')
    if (!same(arm.runs, refs)) fail(`${path}.${label}.runs`, 'derived')
    const complete = runs.filter(completeRun).length
    if (arm.resolvedRuns !== runs.length || arm.completeRuns !== complete || arm.incompleteRuns !== fixtureCount - complete) {
      fail(`${path}.${label}`, 'derived-counts')
    }
    if (!same(arm.metrics, deriveMetrics(runs))) fail(`${path}.${label}.metrics`, 'derived')
  }
  const pairsInput = array(input.pairs, `${path}.pairs`, 0, fixtureCount)
  const pairs = pairsInput.map((item, index) => parseEvaluationPair(item, `${path}.pairs[${index}]`))
  assertStrictOrder(pairs, tupleKey, `${path}.pairs`)
  const baseByTuple = new Map(resolverInput.baseRuns.filter(completeRun).map(run => [tupleKey(run.ref), run.ref]))
  const variantByTuple = new Map(resolverInput.variantRuns.filter(completeRun).map(run => [tupleKey(run.ref), run.ref]))
  const expectedPairs = resolverInput.corpusManifest.fixtures.flatMap(fixture => {
    const baseRun = baseByTuple.get(tupleKey(fixture))
    const variantRun = variantByTuple.get(tupleKey(fixture))
    return baseRun && variantRun ? [{ fixtureId: fixture.fixtureId, fixtureRevision: fixture.fixtureRevision, pairingKey: fixture.pairingKey, baseRun, variantRun }] : []
  })
  if (!same(pairs, expectedPairs)) fail(`${path}.pairs`, 'derived')
  const comparisonsInput = array(input.comparisons, `${path}.comparisons`, METRICS.length, METRICS.length)
  const comparisons = METRICS.map((name, index) => parseComparison(comparisonsInput[index], `${path}.comparisons[${index}]`, name))
  const expectedComparisons = deriveComparisons(baseArm, variantArm)
  if (!same(comparisons, expectedComparisons)) fail(`${path}.comparisons`, 'derived')
  const expectedResult: EvaluationEvidenceV1['result'] = comparisons.some(item => item.result === 'fail')
    ? 'failed'
    : pairs.length !== fixtureCount || baseArm.completeRuns !== fixtureCount || variantArm.completeRuns !== fixtureCount
      || comparisons.slice(0, 2).some(item => item.result === 'unavailable')
      ? 'incomplete'
      : 'passed'
  const result = choice(input.result, ['passed', 'failed', 'incomplete'] as const, `${path}.result`)
  if (result !== expectedResult) fail(`${path}.result`, 'derived')
  return {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    policy: parsePolicy(input.policy, `${path}.policy`),
    corpusId: resolverInput.corpusManifest.corpusId,
    corpusRevision: resolverInput.corpusManifest.corpusRevision,
    corpusManifestDigest: resolverInput.corpusManifest.corpusManifestDigest,
    resolverInput,
    baseArm,
    variantArm,
    pairs,
    comparisons,
    result,
  }
}

function parseEvidenceRef(value: unknown, path: string): EvidenceRefV1 {
  const input = exact(value, path, ['runRef', 'seq'])
  return { runRef: hash(input.runRef, `${path}.runRef`), seq: integer(input.seq, `${path}.seq`, MAX_OBSERVATIONS, 1) }
}

function parseEvidenceRefs(value: unknown, path: string, minimum = 3): EvidenceRefV1[] {
  const result = array(value, path, minimum, 32).map((item, index) => parseEvidenceRef(item, `${path}[${index}]`))
  assertStrictOrder(result, evidenceKey, path)
  return result
}

function parsePattern(value: unknown, path: string): PatternV1 {
  const input = exact(value, path, [
    'schemaVersion', 'id', 'category', 'domainRef', 'taskFamilyRef', 'configHash', 'promptHash',
    'runRefs', 'taskInstanceRefs', 'evidence',
  ])
  const runRefs = array(input.runRefs, `${path}.runRefs`, 3, 32).map((item, index) => hash(item, `${path}.runRefs[${index}]`))
  assertStrictOrder(runRefs, item => item, `${path}.runRefs`)
  const taskInstanceRefs = array(input.taskInstanceRefs, `${path}.taskInstanceRefs`, 2, 32)
    .map((item, index) => hash(item, `${path}.taskInstanceRefs[${index}]`))
  assertStrictOrder(taskInstanceRefs, item => item, `${path}.taskInstanceRefs`)
  const result: PatternV1 = {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    id: hash(input.id, `${path}.id`),
    category: choice(input.category, FAILURE_CLASSES, `${path}.category`),
    domainRef: hash(input.domainRef, `${path}.domainRef`),
    taskFamilyRef: hash(input.taskFamilyRef, `${path}.taskFamilyRef`),
    configHash: hash(input.configHash, `${path}.configHash`),
    promptHash: hash(input.promptHash, `${path}.promptHash`),
    runRefs,
    taskInstanceRefs,
    evidence: parseEvidenceRefs(input.evidence, `${path}.evidence`),
  }
  const { id: _id, ...body } = result
  if (result.id !== sha256Canonical(body)) fail(`${path}.id`, 'derived')
  return result
}

function ruleFor(category: FailureClassV1): LessonV1['rule'] {
  if (['context_loss', 'insufficient_context', 'context_bloat'].includes(category)) return 'review-context-boundary'
  if (category === 'verification_gap') return 'review-verification-scope'
  if (['wrong_model', 'bad_routing', 'prompt_incompatibility'].includes(category)) return 'review-route-fit'
  return 'review-failure-evidence'
}

function parseLesson(value: unknown, path: string): LessonV1 {
  const input = exact(value, path, ['schemaVersion', 'id', 'revision', 'pattern', 'rule'])
  const pattern = parsePattern(input.pattern, `${path}.pattern`)
  const result: LessonV1 = {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    id: hash(input.id, `${path}.id`),
    revision: literal(input.revision, 1, `${path}.revision`),
    pattern,
    rule: choice(input.rule, ['review-context-boundary', 'review-verification-scope', 'review-route-fit', 'review-failure-evidence'] as const, `${path}.rule`),
  }
  if (result.rule !== ruleFor(pattern.category)) fail(`${path}.rule`, 'derived')
  const { id: _id, ...body } = result
  if (result.id !== sha256Canonical(body)) fail(`${path}.id`, 'derived')
  return result
}

function parseCandidate(value: unknown, path: string): CandidateV1 {
  const input = exact(value, path, [
    'schemaVersion', 'id', 'revision', 'kind', 'status', 'lessonId', 'baseConfigHash', 'basePromptHash',
    'hypothesis', 'evidence', 'evaluationRequired', 'autoPromote',
  ])
  const result: CandidateV1 = {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    id: hash(input.id, `${path}.id`),
    revision: literal(input.revision, 1, `${path}.revision`),
    kind: literal(input.kind, 'prompt', `${path}.kind`),
    status: literal(input.status, 'proposed', `${path}.status`),
    lessonId: hash(input.lessonId, `${path}.lessonId`),
    baseConfigHash: hash(input.baseConfigHash, `${path}.baseConfigHash`),
    basePromptHash: hash(input.basePromptHash, `${path}.basePromptHash`),
    hypothesis: choice(input.hypothesis, ['review-context-boundary', 'review-verification-scope', 'review-route-fit', 'review-failure-evidence'] as const, `${path}.hypothesis`),
    evidence: parseEvidenceRefs(input.evidence, `${path}.evidence`),
    evaluationRequired: literal(input.evaluationRequired, true, `${path}.evaluationRequired`),
    autoPromote: literal(input.autoPromote, false, `${path}.autoPromote`),
  }
  const { id: _id, ...body } = result
  if (result.id !== sha256Canonical(body)) fail(`${path}.id`, 'derived')
  return result
}

function parseDomainEvidence(value: unknown, path: string): DomainEvidenceRefV1 {
  const input = exact(value, path, ['domainRef', 'runRef', 'seq'])
  return {
    domainRef: hash(input.domainRef, `${path}.domainRef`),
    runRef: hash(input.runRef, `${path}.runRef`),
    seq: integer(input.seq, `${path}.seq`, MAX_OBSERVATIONS, 1),
  }
}

function parseSupportRun(value: unknown, path: string): CandidateSupportRunV1 {
  const input = exact(value, path, ['domainRef', 'runRef', 'observations', 'seal', 'annotation'])
  const domainRef = hash(input.domainRef, `${path}.domainRef`)
  const runRef = hash(input.runRef, `${path}.runRef`)
  const observations = parseObservations(input.observations, `${path}.observations`)
  const seal = input.seal === null ? null : parseSeal(input.seal, `${path}.seal`)
  const annotation = input.annotation === null ? null : parseAnnotation(input.annotation, `${path}.annotation`)
  for (const observation of observations) {
    if (observation.domainRef !== domainRef || observation.runRef !== runRef) fail(`${path}.observations`, 'identity')
  }
  if (seal && (seal.domainRef !== domainRef || seal.runRef !== runRef)) fail(`${path}.seal`, 'identity')
  if (annotation && (annotation.domainRef !== domainRef || annotation.runRef !== runRef)) fail(`${path}.annotation`, 'identity')
  return { domainRef, runRef, observations, seal, annotation }
}

function evidenceResolves(evidence: readonly EvidenceRefV1[], run: CandidateSupportRunV1): boolean {
  const sequences = new Set(run.observations.map(item => item.seq))
  return evidence.every(item => item.runRef === run.runRef && sequences.has(item.seq))
}

function parseCandidateSupport(value: unknown, path: string): CandidateSupportV1 {
  const input = exact(value, path, ['schemaVersion', 'lesson', 'evidence', 'runs'])
  const lesson = parseLesson(input.lesson, `${path}.lesson`)
  const evidence = array(input.evidence, `${path}.evidence`, 3, 32)
    .map((item, index) => parseDomainEvidence(item, `${path}.evidence[${index}]`))
  assertStrictOrder(evidence, domainEvidenceKey, `${path}.evidence`)
  const runs = array(input.runs, `${path}.runs`, 3, MAX_SUPPORT_RUNS)
    .map((item, index) => parseSupportRun(item, `${path}.runs[${index}]`))
  assertStrictOrder(runs, runKey, `${path}.runs`, 'unique-run')
  const taskInstances = new Set<string>()
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!
    if (!run.seal || !run.annotation || !run.seal.complete || run.seal.lostCount !== 0
      || run.seal.observationCount !== run.observations.length
      || !run.observations.every((item, observationIndex) => item.seq === observationIndex + 1)) fail(`${path}.runs[${index}]`, 'complete')
    if (run.annotation.outcome !== 'failure' || !run.annotation.failure) fail(`${path}.runs[${index}].annotation`, 'failure')
    if (!evidenceResolves(run.annotation.evidence, run) || !evidenceResolves(run.annotation.failure.evidence, run)) {
      fail(`${path}.runs[${index}].annotation`, 'evidence')
    }
    const pattern = lesson.pattern
    if (run.domainRef !== pattern.domainRef || run.annotation.taskFamilyRef !== pattern.taskFamilyRef
      || run.annotation.configHash !== pattern.configHash || run.annotation.promptHash !== pattern.promptHash
      || run.annotation.failure.category !== pattern.category) fail(`${path}.runs[${index}]`, 'cohort')
    taskInstances.add(run.annotation.taskInstanceRef)
  }
  if (taskInstances.size < 2) fail(`${path}.runs`, 'task-diversity')
  const expectedEvidence = lesson.pattern.evidence.map(item => ({ domainRef: lesson.pattern.domainRef, ...item }))
  if (!same(evidence, expectedEvidence)) fail(`${path}.evidence`, 'derived')
  const runsByRef = new Map(runs.map(run => [run.runRef, run]))
  const selectedRuns = lesson.pattern.runRefs.map(runRef => runsByRef.get(runRef))
  if (selectedRuns.some(run => !run)) fail(`${path}.runs`, 'selected-support')
  const expectedTasks = [...new Set(selectedRuns.map(run => run!.annotation!.taskInstanceRef))].sort()
  if (!same(lesson.pattern.taskInstanceRefs, expectedTasks)) fail(`${path}.lesson.pattern.taskInstanceRefs`, 'derived')
  const selectedRunRefs = new Set(lesson.pattern.runRefs)
  if (lesson.pattern.evidence.some(item => !selectedRunRefs.has(item.runRef)
    || !evidenceResolves([item], runsByRef.get(item.runRef)!))) fail(`${path}.lesson.pattern.evidence`, 'unresolved')
  for (const runRef of lesson.pattern.runRefs) {
    if (!lesson.pattern.evidence.some(item => item.runRef === runRef)) fail(`${path}.lesson.pattern.evidence`, 'coverage')
  }
  assertTelemetryBudget(runs, path)
  return { schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`), lesson, evidence, runs }
}

function assertTelemetryBudget(runs: readonly (CandidateSupportRunV1 | ResolvedRunEvidenceV1)[], path: string): void {
  let recordCount = 0
  let telemetryBytes = 0
  let annotationCount = 0
  let annotationElementsBytes = 0
  for (const run of runs) {
    const observations = run.observations
    for (const record of [...observations, ...(run.seal ? [run.seal] : [])]) {
      recordCount += 1
      if (recordCount > MAX_RECORDS) fail(path, 'record-count')
      const bytes = encoder.encode(canonicalGovernanceJson(record)).byteLength + 1
      if (bytes > MAX_RECORD_BYTES || telemetryBytes > MAX_TELEMETRY_BYTES - bytes) fail(path, 'telemetry-bytes')
      telemetryBytes += bytes
    }
    if (run.annotation) {
      annotationCount += 1
      if (annotationCount > MAX_ANNOTATIONS) fail(path, 'annotation-count')
      const bytes = encoder.encode(canonicalGovernanceJson(run.annotation)).byteLength + 1
      if (bytes > MAX_RECORD_BYTES) fail(path, 'annotation-record-bytes')
      annotationElementsBytes += bytes - 1
      if (annotationElementsBytes + Math.max(0, annotationCount - 1) + 2 > MAX_ANNOTATION_BYTES) fail(path, 'annotation-bytes')
    }
  }
}

function parseDecision(value: unknown, path: string): DecisionRecordV1 {
  const input = exact(value, path, ['decisionId', 'actorId', 'occurredAtMs', 'reasonDigest'])
  return {
    decisionId: identifier(input.decisionId, `${path}.decisionId`),
    actorId: identifier(input.actorId, `${path}.actorId`),
    occurredAtMs: integer(input.occurredAtMs, `${path}.occurredAtMs`),
    reasonDigest: hash(input.reasonDigest, `${path}.reasonDigest`),
  }
}

function nullableDecision(value: unknown, path: string): DecisionRecordV1 | null {
  return value === null ? null : parseDecision(value, path)
}

function parseProposal(value: unknown, path: string): GovernanceProposalV1 {
  const input = exact(value, path, [
    'schemaVersion', 'proposalId', 'candidate', 'candidateSupport', 'bundleVersion', 'policyGeneration',
    'surface', 'base', 'variant', 'evaluation', 'status', 'approval', 'rejection', 'promotion',
    'rollback', 'rollbackTarget',
  ])
  const candidate = parseCandidate(input.candidate, `${path}.candidate`)
  const candidateSupport = parseCandidateSupport(input.candidateSupport, `${path}.candidateSupport`)
  const base = parseTemplateArtifact(input.base, `${path}.base`)
  const variant = parseTemplateArtifact(input.variant, `${path}.variant`)
  const evaluation = parseEvaluationEvidence(input.evaluation, `${path}.evaluation`)
  const status = choice(input.status, ['proposed', 'approved', 'rejected', 'promoted', 'rolled-back'] as const, `${path}.status`)
  const approval = nullableDecision(input.approval, `${path}.approval`)
  const rejection = nullableDecision(input.rejection, `${path}.rejection`)
  const promotion = nullableDecision(input.promotion, `${path}.promotion`)
  const rollback = nullableDecision(input.rollback, `${path}.rollback`)
  const rollbackTarget = input.rollbackTarget === null ? null : parseArtifactRef(input.rollbackTarget, `${path}.rollbackTarget`)
  if (rollbackTarget && rollbackTarget.surface !== 'template') fail(`${path}.rollbackTarget.surface`, 'literal')
  if (candidate.lessonId !== candidateSupport.lesson.id || candidate.hypothesis !== candidateSupport.lesson.rule
    || !same(candidate.evidence, candidateSupport.lesson.pattern.evidence)) fail(`${path}.candidate`, 'support')
  if (candidate.baseConfigHash !== base.configHash || candidate.basePromptHash !== base.promptHash) fail(`${path}.candidate`, 'base')
  if (!same(evaluation.resolverInput.baseArtifact, base) || !same(evaluation.resolverInput.variantArtifact, variant)) fail(`${path}.evaluation`, 'artifacts')
  const stateValid = status === 'proposed'
    ? !approval && !rejection && !promotion && !rollback && !rollbackTarget
    : status === 'approved'
      ? !!approval && !rejection && !promotion && !rollback && !rollbackTarget
      : status === 'rejected'
        ? !promotion && !rollback && !rollbackTarget && !!rejection
        : status === 'promoted'
          ? !!approval && !rejection && !!promotion && !rollback && !!rollbackTarget
          : !!approval && !rejection && !!promotion && !!rollback && !!rollbackTarget
  if (!stateValid) {
    const slot = status === 'approved' ? 'approval' : status === 'rejected' ? 'rejection' : status === 'promoted' ? 'promotion' : status === 'rolled-back' ? 'rollback' : 'status'
    fail(`${path}.${slot}`, 'state')
  }
  if ((status === 'approved' || status === 'promoted' || status === 'rolled-back') && evaluation.result !== 'passed') {
    fail(`${path}.evaluation.result`, 'state')
  }
  assertTelemetryBudget([
    ...candidateSupport.runs,
    ...evaluation.resolverInput.baseRuns,
    ...evaluation.resolverInput.variantRuns,
  ], path)
  return {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    proposalId: identifier(input.proposalId, `${path}.proposalId`),
    candidate,
    candidateSupport,
    bundleVersion: identifier(input.bundleVersion, `${path}.bundleVersion`),
    policyGeneration: identifier(input.policyGeneration, `${path}.policyGeneration`),
    surface: literal(input.surface, 'template', `${path}.surface`),
    base,
    variant,
    evaluation,
    status,
    approval,
    rejection,
    promotion,
    rollback,
    rollbackTarget: rollbackTarget as (ArtifactRefV1 & { surface: GovernanceSurfaceV1 }) | null,
  }
}

function parseEntry(value: unknown, path: string): GovernanceEntryV1 {
  const input = exact(value, path, ['schemaVersion', 'sequence', 'entryId', 'predecessorDigest', 'transition', 'decision', 'proposal'])
  const transition = choice(input.transition, ['propose', 'approve', 'reject', 'promote', 'rollback'] as const, `${path}.transition`)
  const decision = nullableDecision(input.decision, `${path}.decision`)
  const proposal = parseProposal(input.proposal, `${path}.proposal`)
  if (transition === 'propose') {
    if (decision !== null || proposal.status !== 'proposed') fail(path, 'transition')
  } else {
    const expectedStatus = transition === 'approve' ? 'approved'
      : transition === 'reject' ? 'rejected'
        : transition === 'promote' ? 'promoted'
          : 'rolled-back'
    const slot = transition === 'approve' ? proposal.approval
      : transition === 'reject' ? proposal.rejection
        : transition === 'promote' ? proposal.promotion
          : proposal.rollback
    if (proposal.status !== expectedStatus || !decision || !slot || !same(decision, slot)) fail(path, 'transition')
  }
  return {
    schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`),
    sequence: integer(input.sequence, `${path}.sequence`, 1_024, 1),
    entryId: hash(input.entryId, `${path}.entryId`),
    predecessorDigest: nullableHash(input.predecessorDigest, `${path}.predecessorDigest`),
    transition,
    decision,
    proposal,
  }
}

function immutableProposal(value: GovernanceProposalV1): unknown {
  return {
    schemaVersion: value.schemaVersion,
    proposalId: value.proposalId,
    candidate: value.candidate,
    candidateSupport: value.candidateSupport,
    bundleVersion: value.bundleVersion,
    policyGeneration: value.policyGeneration,
    surface: value.surface,
    base: value.base,
    variant: value.variant,
    evaluation: value.evaluation,
  }
}

function parseLedger(value: unknown, path: string): GovernanceLedgerV1 {
  const input = exact(value, path, ['schemaVersion', 'initialActive', 'entries', 'headDigest'])
  const initialInput = exact(input.initialActive, `${path}.initialActive`, ['template'])
  const initialActive = { template: parseTemplateArtifact(initialInput.template, `${path}.initialActive.template`) }
  const entries = array(input.entries, `${path}.entries`, 0, 1_024).map((item, index) => parseEntry(item, `${path}.entries[${index}]`))
  const seedDigest = sha256Canonical({ schemaVersion: 1, initialActive })
  const proposals = new Map<string, GovernanceProposalV1>()
  const decisionIds = new Set<string>()
  type Occurrence = { artifact: TemplateArtifactV1, proposalId: string | null, sequence: number | null, predecessor: Occurrence | null }
  let current: Occurrence = { artifact: initialActive.template, proposalId: null, sequence: null, predecessor: null }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const entryPath = `${path}.entries[${index}]`
    if (entry.sequence !== index + 1) fail(`${entryPath}.sequence`, 'derived')
    const predecessor = index === 0 ? null : entries[index - 1]!.entryId
    if (entry.predecessorDigest !== predecessor) fail(`${entryPath}.predecessorDigest`, 'derived')
    const body = {
      schemaVersion: entry.schemaVersion,
      seedDigest,
      sequence: entry.sequence,
      predecessorDigest: entry.predecessorDigest,
      transition: entry.transition,
      decision: entry.decision,
      proposal: entry.proposal,
    }
    if (entry.entryId !== sha256Canonical(body)) fail(`${entryPath}.entryId`, 'derived')
    if (entry.decision) {
      if (decisionIds.has(entry.decision.decisionId)) fail(`${entryPath}.decision.decisionId`, 'unique')
      decisionIds.add(entry.decision.decisionId)
    }
    const previous = proposals.get(entry.proposal.proposalId)
    if (entry.transition === 'propose') {
      if (previous) fail(`${entryPath}.proposal.proposalId`, 'unique')
      if (!same(entry.proposal.base, current.artifact)) fail(`${entryPath}.proposal.base`, 'active')
    } else {
      if (!previous || !same(immutableProposal(previous), immutableProposal(entry.proposal))) fail(`${entryPath}.proposal`, 'immutable')
      const expected = entry.transition === 'approve' ? 'proposed'
        : entry.transition === 'reject' ? ['proposed', 'approved']
          : entry.transition === 'promote' ? 'approved'
            : 'promoted'
      if (Array.isArray(expected) ? !expected.includes(previous.status) : previous.status !== expected) fail(entryPath, 'source-state')
      const mutableKeys = ['approval', 'rejection', 'promotion', 'rollback', 'rollbackTarget'] as const
      for (const key of mutableKeys) {
        const changedKey = entry.transition === 'approve' ? 'approval'
          : entry.transition === 'reject' ? 'rejection'
            : entry.transition === 'promote' ? (key === 'rollbackTarget' ? 'rollbackTarget' : 'promotion')
              : 'rollback'
        if (key !== changedKey && !(entry.transition === 'promote' && key === 'rollbackTarget')
          && !same(previous[key], entry.proposal[key])) fail(`${entryPath}.proposal.${key}`, 'retained')
      }
      if (entry.transition === 'promote') {
        if (!same(entry.proposal.base, current.artifact) || same(entry.proposal.variant, current.artifact)) fail(entryPath, 'active')
        if (!entry.proposal.rollbackTarget || !same(entry.proposal.rollbackTarget, current.artifact.ref)) fail(`${entryPath}.proposal.rollbackTarget`, 'derived')
        current = { artifact: entry.proposal.variant, proposalId: entry.proposal.proposalId, sequence: entry.sequence, predecessor: current }
      }
      if (entry.transition === 'rollback') {
        if (current.proposalId !== entry.proposal.proposalId || !current.predecessor
          || !entry.proposal.rollbackTarget || !same(entry.proposal.rollbackTarget, current.predecessor.artifact.ref)) fail(entryPath, 'active')
        current = current.predecessor
      }
    }
    proposals.set(entry.proposal.proposalId, entry.proposal)
  }
  const headDigest = nullableHash(input.headDigest, `${path}.headDigest`)
  const expectedHead = entries.length === 0 ? null : entries[entries.length - 1]!.entryId
  if (headDigest !== expectedHead) fail(`${path}.headDigest`, 'derived')
  return { schemaVersion: literal(input.schemaVersion, 1, `${path}.schemaVersion`), initialActive, entries, headDigest }
}

export const validateArtifactRefV1 = (value: unknown): ArtifactRefV1 => validateWith(value, parseArtifactRef, 'artifactRef')
export const validateTemplateArtifactV1 = (value: unknown): TemplateArtifactV1 => validateWith(value, parseTemplateArtifact, 'templateArtifact')
export const validateArmMetricObservationV1 = (value: unknown): ArmMetricObservationV1 => validateWith(value, parseStandaloneMetric, 'armMetricObservation')
export const validateCorpusFixtureV1 = (value: unknown): CorpusFixtureV1 => validateWith(value, parseCorpusFixture, 'corpusFixture')
export const validateCorpusManifestV1 = (value: unknown): CorpusManifestV1 => validateWith(value, parseCorpusManifest, 'corpusManifest')
export const validateEvaluationRunRefV1 = (value: unknown): EvaluationRunRefV1 => validateWith(value, parseEvaluationRunRef, 'evaluationRunRef')
export const validateEvaluationArmV1 = (value: unknown): EvaluationArmV1 => validateWith(value, parseEvaluationArm, 'evaluationArm')
export const validateEvaluationPairV1 = (value: unknown): EvaluationPairV1 => validateWith(value, parseEvaluationPair, 'evaluationPair')
export const validateResolvedRunEvidenceV1 = (value: unknown): ResolvedRunEvidenceV1 => validateWith(value, parseResolvedRun, 'resolvedRunEvidence')
export const validateOfflineEvidenceResolverInputV1 = (value: unknown): OfflineEvidenceResolverInputV1 => validateWith(value, parseResolverInput, 'offlineEvidenceResolverInput')
export const validateEvaluatorPolicyRefV1 = (value: unknown): EvaluatorPolicyRefV1 => validateWith(value, parsePolicy, 'evaluatorPolicyRef')
export const validateMetricComparisonV1 = (value: unknown): MetricComparisonV1 => validateWith(value, (input, path) => {
  const record = exact(input, path, ['name', 'baseValue', 'variantValue', 'delta', 'result'])
  const name = choice(record.name, METRICS, `${path}.name`)
  return parseComparison(input, path, name)
}, 'metricComparison')
export const validateEvaluationEvidenceV1 = (value: unknown): EvaluationEvidenceV1 => validateWith(value, parseEvaluationEvidence, 'evaluationEvidence')
export const validateDomainEvidenceRefV1 = (value: unknown): DomainEvidenceRefV1 => validateWith(value, parseDomainEvidence, 'domainEvidenceRef')
export const validateCandidateSupportRunV1 = (value: unknown): CandidateSupportRunV1 => validateWith(value, parseSupportRun, 'candidateSupportRun')
export const validateCandidateSupportV1 = (value: unknown): CandidateSupportV1 => validateWith(value, parseCandidateSupport, 'candidateSupport')
export const validateDecisionRecordV1 = (value: unknown): DecisionRecordV1 => validateWith(value, parseDecision, 'decisionRecord')
export const validateGovernanceProposalV1 = (value: unknown): GovernanceProposalV1 => validateWith(value, parseProposal, 'governanceProposal')
export const validateGovernanceEntryV1 = (value: unknown): GovernanceEntryV1 => validateWith(value, parseEntry, 'governanceEntry')
export const validateGovernanceLedgerV1 = (value: unknown): GovernanceLedgerV1 => validateWith(value, parseLedger, 'governanceLedger')
