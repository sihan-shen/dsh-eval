import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  CandidateV1,
  LessonV1,
  ObservationV1,
  RunAnnotationV1,
  RunSealV1,
} from '@ds-plugins/dsh-telemetry/contracts'
import { sha256Canonical } from '../../src/governance/index.js'
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
} from '../../src/governance/index.js'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(testDirectory, '../..')
const allowedBuiltGovernanceExternalImports = new Set([
  '@ds-plugins/dsh-telemetry/contracts',
  'node:crypto',
])

type SyntheticFile = string | { symlink: string }

function extractImportSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'governance-import-scan.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics: readonly ts.Diagnostic[]
  }).parseDiagnostics
  if (parseDiagnostics.length > 0) {
    throw new Error('Governance source could not be parsed')
  }

  const imports: Array<{ index: number, specifier: string }> = []
  const addSpecifier = (node: ts.StringLiteralLike): void => {
    imports.push({ index: node.getStart(sourceFile), specifier: node.text })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        addSpecifier(node.moduleSpecifier)
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) {
        const expression = node.arguments.map(argument => argument.getText(sourceFile)).join(', ')
        throw new Error(`Dynamic import specifier must be a string literal: ${expression}`)
      }
      addSpecifier(argument)
    }
    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal)) {
        throw new Error('Import type specifier must be a string literal')
      }
      addSpecifier(node.argument.literal)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
    .sort((left, right) => left.index - right.index)
    .map(({ specifier }) => specifier)
}

function validateDynamicImportSpecifiers(source: string): void {
  extractImportSpecifiers(source)
}

function isMissingModuleError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

type MainGraphKind = 'source' | 'runtime' | 'declaration'

function isWithinRoot(filePath: string, rootPath: string): boolean {
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`)
}

async function canonicalPathWithinRoot(filePath: string, rootPath: string): Promise<string> {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootPath), realpath(filePath)])
  if (!isWithinRoot(canonicalFile, canonicalRoot)) {
    throw new Error(`Graph import resolves outside the scanned package root: ${filePath}`)
  }
  return canonicalFile
}

function localModuleCandidates(importingFile: string, specifier: string, kind: MainGraphKind): string[] {
  const candidate = resolve(dirname(importingFile), specifier)
  if (kind === 'source') {
    const sourceBase = candidate.endsWith('.js') ? candidate.slice(0, -3) : candidate
    return candidate.endsWith('.d.ts')
      ? [candidate]
      : [candidate.endsWith('.ts') || candidate.endsWith('.tsx') ? candidate : `${sourceBase}.ts`, `${sourceBase}.tsx`, `${sourceBase}.d.ts`, resolve(sourceBase, 'index.ts')]
  }
  if (kind === 'declaration') {
    const declarationBase = candidate.endsWith('.js') ? candidate.slice(0, -3) : candidate
    return candidate.endsWith('.d.ts')
      ? [candidate]
      : [`${declarationBase}.d.ts`, resolve(declarationBase, 'index.d.ts')]
  }
  return candidate.endsWith('.js')
    ? [candidate]
    : [candidate, `${candidate}.js`, resolve(candidate, 'index.js')]
}

async function resolveLocalModule(
  importingFile: string,
  specifier: string,
  kind: MainGraphKind,
  rootPath: string,
): Promise<string> {
  for (const localFile of localModuleCandidates(importingFile, specifier, kind)) {
    try {
      return await canonicalPathWithinRoot(localFile, rootPath)
    } catch (error) {
      if (!isMissingModuleError(error)) throw error
    }
  }

  const label = kind === 'source' ? 'Graph import' : 'Built governance import'
  throw new Error(`${label} does not resolve: ${specifier} from ${importingFile}`)
}

async function scanMainEntryGraph(
  entryFile: string,
  kind: MainGraphKind,
  rootPath: string,
): Promise<void> {
  const visitedFiles = new Set<string>()

  async function visit(filePath: string): Promise<void> {
    const canonicalFile = await canonicalPathWithinRoot(filePath, rootPath)
    if (visitedFiles.has(canonicalFile)) return
    visitedFiles.add(canonicalFile)

    const source = await readFile(canonicalFile, 'utf8')
    validateDynamicImportSpecifiers(source)
    for (const specifier of extractImportSpecifiers(source)) {
      if (isGovernanceModuleSpecifier(specifier)) {
        throw new Error(`${kind} main entry transitively references governance: ${specifier}`)
      }
      if (specifier.startsWith('.')) {
        await visit(await resolveLocalModule(canonicalFile, specifier, kind, rootPath))
      }
    }
  }

  await visit(entryFile)
}

async function assertMainEntryGraphIsIsolated(
  entryFiles: readonly (readonly [kind: MainGraphKind, filePath: string])[],
  rootPath = packageRoot,
): Promise<void> {
  for (const [kind, filePath] of entryFiles) {
    await scanMainEntryGraph(filePath, kind, rootPath)
  }
}

async function collectBuiltGovernanceExternalImports(
  entryFile: string,
  rootPath = packageRoot,
): Promise<Set<string>> {
  const visitedFiles = new Set<string>()
  const externalImports = new Set<string>()

  async function visit(filePath: string, kind: MainGraphKind): Promise<void> {
    const canonicalFile = await canonicalPathWithinRoot(filePath, rootPath)
    if (visitedFiles.has(canonicalFile)) return

    const source = await readFile(canonicalFile, 'utf8')
    visitedFiles.add(canonicalFile)
    validateDynamicImportSpecifiers(source)

    for (const specifier of extractImportSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        await visit(await resolveLocalModule(canonicalFile, specifier, kind, rootPath), kind)
      } else {
        externalImports.add(specifier)
      }
    }
  }

  await visit(entryFile, 'runtime')
  const declarationEntry = entryFile.endsWith('.js')
    ? `${entryFile.slice(0, -3)}.d.ts`
    : `${entryFile}.d.ts`
  try {
    await realpath(declarationEntry)
    await visit(declarationEntry, 'declaration')
  } catch (error) {
    if (!isMissingModuleError(error)) throw error
  }
  return externalImports
}

async function assertBuiltGovernanceExternalImportsAreAllowed(
  entryFile: string,
  rootPath = packageRoot,
): Promise<void> {
  const externalImports = await collectBuiltGovernanceExternalImports(entryFile, rootPath)
  expect(externalImports).toEqual(allowedBuiltGovernanceExternalImports)
}

async function withSyntheticBuiltGraph<T>(
  files: Record<string, SyntheticFile>,
  callback: (entryFile: string, fixtureRoot: string) => Promise<T>,
): Promise<T> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-governance-graph-'))
  try {
    await Promise.all(Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = resolve(fixtureRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      if (typeof source === 'string') {
        await writeFile(filePath, source, 'utf8')
      } else {
        await symlink(source.symlink, filePath)
      }
    }))
    return await callback(resolve(fixtureRoot, 'entry.js'), fixtureRoot)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

function isGovernanceModuleSpecifier(specifier: string): boolean {
  return specifier
    .replaceAll('\\', '/')
    .split('/')
    .some(segment => segment.replace(/\.(?:[cm]?js|d\.ts|tsx?|jsx?)$/u, '') === 'governance')
}

function extractGovernanceModuleSpecifiers(source: string): string[] {
  return extractImportSpecifiers(source).filter(isGovernanceModuleSpecifier)
}

describe('governance contracts', () => {
  it('exports every v1 governance contract with exact fields and literal types', () => {
    expectTypeOf<GovernanceSurfaceV1>().toEqualTypeOf<'template' | 'routing' | 'verification' | 'kernel'>()

    expectTypeOf<keyof ArtifactRefV1>().toEqualTypeOf<'schemaVersion' | 'surface' | 'version' | 'digest'>()
    expectTypeOf<ArtifactRefV1>().toEqualTypeOf<{
      schemaVersion: 1
      surface: GovernanceSurfaceV1
      version: string
      digest: string
    }>()

    expectTypeOf<keyof TemplateArtifactV1>().toEqualTypeOf<'schemaVersion' | 'ref' | 'configHash' | 'promptHash' | 'bindingDigest'>()
    expectTypeOf<TemplateArtifactV1>().toEqualTypeOf<{
      schemaVersion: 1
      ref: ArtifactRefV1 & { surface: 'template' }
      configHash: string
      promptHash: string
      bindingDigest: string
    }>()

    expectTypeOf<keyof CorpusFixtureV1>().toEqualTypeOf<
      'fixtureId' | 'fixtureRevision' | 'pairingKey' | 'baseDomainRef' | 'variantDomainRef'
      | 'taskFamilyRef' | 'taskInstanceRef' | 'fixtureInputDigest'
    >()
    expectTypeOf<CorpusFixtureV1>().toEqualTypeOf<{
      fixtureId: string
      fixtureRevision: string
      pairingKey: string
      baseDomainRef: string
      variantDomainRef: string
      taskFamilyRef: string
      taskInstanceRef: string
      fixtureInputDigest: string
    }>()

    expectTypeOf<keyof CorpusManifestV1>().toEqualTypeOf<
      'schemaVersion' | 'corpusId' | 'corpusRevision' | 'fixtures' | 'corpusManifestDigest'
    >()
    expectTypeOf<CorpusManifestV1>().toEqualTypeOf<{
      schemaVersion: 1
      corpusId: 'template-offline-v1-corpus'
      corpusRevision: '1'
      fixtures: CorpusFixtureV1[]
      corpusManifestDigest: string
    }>()

    expectTypeOf<keyof EvaluationRunRefV1>().toEqualTypeOf<
      'domainRef' | 'runRef' | 'fixtureId' | 'fixtureRevision' | 'pairingKey'
    >()
    expectTypeOf<EvaluationRunRefV1>().toEqualTypeOf<{
      domainRef: string
      runRef: string
      fixtureId: string
      fixtureRevision: string
      pairingKey: string
    }>()

    expectTypeOf<keyof EvaluationArmV1>().toEqualTypeOf<
      'artifact' | 'corpusRevision' | 'runs' | 'fixtureRuns' | 'resolvedRuns' | 'completeRuns'
      | 'incompleteRuns' | 'excludedRuns' | 'metrics'
    >()
    expectTypeOf<EvaluationArmV1>().toEqualTypeOf<{
      artifact: TemplateArtifactV1
      corpusRevision: '1'
      runs: EvaluationRunRefV1[]
      fixtureRuns: number
      resolvedRuns: number
      completeRuns: number
      incompleteRuns: number
      excludedRuns: number
      metrics: ArmMetricObservationV1[]
    }>()

    expectTypeOf<keyof ArmMetricObservationV1>().toEqualTypeOf<
      'name' | 'value' | 'numerator' | 'denominator' | 'observedRuns' | 'eligibleRuns' | 'basis'
    >()
    expectTypeOf<ArmMetricObservationV1>().toEqualTypeOf<{
      name: string
      value: number | null
      numerator: number
      denominator: number
      observedRuns: number
      eligibleRuns: number
      basis: 'observed' | 'estimated' | 'unavailable'
    }>()

    expectTypeOf<keyof EvaluationPairV1>().toEqualTypeOf<
      'fixtureId' | 'fixtureRevision' | 'pairingKey' | 'baseRun' | 'variantRun'
    >()
    expectTypeOf<EvaluationPairV1>().toEqualTypeOf<{
      fixtureId: string
      fixtureRevision: string
      pairingKey: string
      baseRun: EvaluationRunRefV1
      variantRun: EvaluationRunRefV1
    }>()

    expectTypeOf<keyof ResolvedRunEvidenceV1>().toEqualTypeOf<'ref' | 'observations' | 'seal' | 'annotation'>()
    expectTypeOf<ResolvedRunEvidenceV1>().toEqualTypeOf<{
      ref: EvaluationRunRefV1
      observations: ObservationV1[]
      seal: RunSealV1 | null
      annotation: RunAnnotationV1 | null
    }>()

    expectTypeOf<keyof OfflineEvidenceResolverInputV1>().toEqualTypeOf<
      'schemaVersion' | 'corpusManifest' | 'baseArtifact' | 'variantArtifact' | 'baseRuns' | 'variantRuns'
    >()
    expectTypeOf<OfflineEvidenceResolverInputV1>().toEqualTypeOf<{
      schemaVersion: 1
      corpusManifest: CorpusManifestV1
      baseArtifact: TemplateArtifactV1
      variantArtifact: TemplateArtifactV1
      baseRuns: ResolvedRunEvidenceV1[]
      variantRuns: ResolvedRunEvidenceV1[]
    }>()

    expectTypeOf<keyof EvaluatorPolicyRefV1>().toEqualTypeOf<'policyId' | 'policyRevision' | 'policyDigest'>()
    expectTypeOf<EvaluatorPolicyRefV1>().toEqualTypeOf<{
      policyId: 'template-offline-v1'
      policyRevision: 1
      policyDigest: string
    }>()

    expectTypeOf<keyof MetricComparisonV1>().toEqualTypeOf<
      'name' | 'baseValue' | 'variantValue' | 'delta' | 'result'
    >()
    expectTypeOf<MetricComparisonV1>().toEqualTypeOf<{
      name: string
      baseValue: number | null
      variantValue: number | null
      delta: number | null
      result: 'pass' | 'fail' | 'unavailable'
    }>()

    expectTypeOf<keyof EvaluationEvidenceV1>().toEqualTypeOf<
      'schemaVersion' | 'policy' | 'corpusId' | 'corpusRevision' | 'corpusManifestDigest'
      | 'resolverInput' | 'baseArm' | 'variantArm' | 'pairs' | 'comparisons' | 'result'
    >()
    expectTypeOf<EvaluationEvidenceV1>().toEqualTypeOf<{
      schemaVersion: 1
      policy: EvaluatorPolicyRefV1
      corpusId: string
      corpusRevision: string
      corpusManifestDigest: string
      resolverInput: OfflineEvidenceResolverInputV1
      baseArm: EvaluationArmV1
      variantArm: EvaluationArmV1
      pairs: EvaluationPairV1[]
      comparisons: MetricComparisonV1[]
      result: 'passed' | 'failed' | 'incomplete'
    }>()

    expectTypeOf<keyof DomainEvidenceRefV1>().toEqualTypeOf<'domainRef' | 'runRef' | 'seq'>()
    expectTypeOf<DomainEvidenceRefV1>().toEqualTypeOf<{
      domainRef: string
      runRef: string
      seq: number
    }>()

    expectTypeOf<keyof CandidateSupportRunV1>().toEqualTypeOf<
      'domainRef' | 'runRef' | 'observations' | 'seal' | 'annotation'
    >()
    expectTypeOf<CandidateSupportRunV1>().toEqualTypeOf<{
      domainRef: string
      runRef: string
      observations: ObservationV1[]
      seal: RunSealV1 | null
      annotation: RunAnnotationV1 | null
    }>()

    expectTypeOf<keyof CandidateSupportV1>().toEqualTypeOf<'schemaVersion' | 'lesson' | 'evidence' | 'runs'>()
    expectTypeOf<CandidateSupportV1>().toEqualTypeOf<{
      schemaVersion: 1
      lesson: LessonV1
      evidence: DomainEvidenceRefV1[]
      runs: CandidateSupportRunV1[]
    }>()

    expectTypeOf<keyof DecisionRecordV1>().toEqualTypeOf<'decisionId' | 'actorId' | 'occurredAtMs' | 'reasonDigest'>()
    expectTypeOf<DecisionRecordV1>().toEqualTypeOf<{
      decisionId: string
      actorId: string
      occurredAtMs: number
      reasonDigest: string
    }>()

    expectTypeOf<keyof GovernanceProposalV1>().toEqualTypeOf<
      'schemaVersion' | 'proposalId' | 'candidate' | 'candidateSupport' | 'bundleVersion'
      | 'policyGeneration' | 'surface' | 'base' | 'variant' | 'evaluation' | 'status'
      | 'approval' | 'rejection' | 'promotion' | 'rollback' | 'rollbackTarget'
    >()
    expectTypeOf<GovernanceProposalV1>().toEqualTypeOf<{
      schemaVersion: 1
      proposalId: string
      candidate: CandidateV1
      candidateSupport: CandidateSupportV1
      bundleVersion: string
      policyGeneration: string
      surface: 'template'
      base: TemplateArtifactV1
      variant: TemplateArtifactV1
      evaluation: EvaluationEvidenceV1
      status: 'proposed' | 'approved' | 'rejected' | 'promoted' | 'rolled-back'
      approval: DecisionRecordV1 | null
      rejection: DecisionRecordV1 | null
      promotion: DecisionRecordV1 | null
      rollback: DecisionRecordV1 | null
      rollbackTarget: ArtifactRefV1 | null
    }>()

    expectTypeOf<keyof GovernanceEntryV1>().toEqualTypeOf<
      'schemaVersion' | 'sequence' | 'entryId' | 'predecessorDigest' | 'transition' | 'decision' | 'proposal'
    >()
    expectTypeOf<GovernanceEntryV1>().toEqualTypeOf<{
      schemaVersion: 1
      sequence: number
      entryId: string
      predecessorDigest: string | null
      transition: 'propose' | 'approve' | 'reject' | 'promote' | 'rollback'
      decision: DecisionRecordV1 | null
      proposal: GovernanceProposalV1
    }>()

    expectTypeOf<keyof GovernanceLedgerV1>().toEqualTypeOf<'schemaVersion' | 'initialActive' | 'entries' | 'headDigest'>()
    expectTypeOf<GovernanceLedgerV1>().toEqualTypeOf<{
      schemaVersion: 1
      initialActive: { template: TemplateArtifactV1 }
      entries: GovernanceEntryV1[]
      headDigest: string | null
    }>()
  })

  it('hashes UTF-8 canonical JSON without a trailing newline', () => {
    expect(sha256Canonical({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 1, a: 2 }, 0] }))
      .toBe('7dd74fec130f7342e7a1b8f9dc905c77a11b1bbc09a72898ce00bb4e97e97532')
  })

  it('hashes non-ASCII canonical JSON using its UTF-8 bytes', () => {
    expect(sha256Canonical({ greeting: '你好, мир 👋', nested: { café: '東京' }, list: ['é', '😀'] }))
      .toBe('86cefdad28cdda069982c9daac937f291eae0f666a4faa48c68f9ee1c3c0998c')
  })

  it('rejects enumerable accessors without invoking their getters', () => {
    let getterCalls = 0
    const value = {}
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 'should not be read'
      },
    })

    expect(() => sha256Canonical(value)).toThrow('accessor')
    expect(getterCalls).toBe(0)
  })

  it('rejects non-enumerable fields instead of omitting them from the hash', () => {
    const value = { visible: 1 }
    Object.defineProperty(value, 'hidden', { value: 2, enumerable: false })

    expect(() => sha256Canonical(value)).toThrow('non-enumerable')
  })

  it('rejects sparse arrays and named array properties', () => {
    const sparse = [] as unknown[]
    sparse.length = 1
    expect(() => sha256Canonical(sparse)).toThrow('sparse')

    const named = [] as unknown[] & { extra?: number }
    named.extra = 1
    expect(() => sha256Canonical(named)).toThrow('array property')
  })

  it('keeps canonicalization errors bounded and free of caller-supplied keys', () => {
    const value = [] as unknown[]
    const secretKey = 'PRIVATE_FIELD_' + 'x'.repeat(10_000)
    Object.defineProperty(value, secretKey, { value: 1, enumerable: true })

    let message = ''
    try {
      sha256Canonical(value)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/^governance canonical value invalid array property$/u)
    expect(message).not.toContain(secretKey)
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(512)
  })

  it('rejects canonical values beyond the governance depth and string bounds', () => {
    let nested: unknown = null
    for (let index = 0; index < 33; index += 1) nested = { nested }

    expect(() => sha256Canonical(nested)).toThrow('depth')
    expect(() => sha256Canonical({ text: 'x'.repeat(129) })).toThrow('string')
  })

  it('computes the artifact binding digest from the specified canonical preimage', () => {
    const ref: ArtifactRefV1 & { surface: 'template' } = {
      schemaVersion: 1,
      surface: 'template',
      version: '1.2.3',
      digest: 'd'.repeat(64),
    }
    const bindingPreimage = {
      schemaVersion: 1,
      ref,
      configHash: 'c'.repeat(64),
      promptHash: 'p'.repeat(64),
    }

    expect(sha256Canonical(bindingPreimage))
      .toBe('f0f7fdf09fe29680651aed4b5674e7952313427fdae923fb6b4b0c645c72cec4')
  })

  it('publishes governance as an isolated package subpath', async () => {
    const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }

    expect(packageJson.exports['./governance']).toEqual({
      types: './lib/src/governance/index.d.ts',
      default: './lib/src/governance/index.js',
    })
  })

  it('loads the built governance subpath and keeps it out of the main entrypoint', async () => {
    const [governance, main] = await Promise.all([
      import('@ds-plugins/dsh-eval/governance'),
      import('@ds-plugins/dsh-eval'),
    ])

    expect(governance.sha256Canonical).toBeTypeOf('function')
    expect(governance.sha256Canonical({ unicode: '雪だるま' }))
      .toBe('9c3abda41754082a404fe2b303752983a759366e642898a2888b8e68c9be6f96')
    expect(main).not.toHaveProperty('sha256Canonical')
  })

  it('keeps governance out of the main source, runtime, and declaration graphs', async () => {
    const mainEntryFiles = [
      ['source', resolve(packageRoot, 'src/index.ts')],
      ['runtime', resolve(packageRoot, 'lib/src/index.js')],
      ['declaration', resolve(packageRoot, 'lib/src/index.d.ts')],
    ] as const

    await assertMainEntryGraphIsIsolated(mainEntryFiles)
  })

  it('keeps governance out of transitive main source, runtime, and declaration graphs', async () => {
    await expect(withSyntheticBuiltGraph({
      'entry.ts': "export * from './nested.js'",
      'entry.js': "export * from './nested.js'",
      'entry.d.ts': "export * from './nested.js'",
      'nested.ts': "export * from './deep.js'",
      'nested.js': "export * from './deep.js'",
      'nested.d.ts': "export * from './deep.js'",
      'deep.ts': "export type { GovernanceSurfaceV1 } from './governance/index.js'",
      'deep.js': "export * from './governance/index.js'",
      'deep.d.ts': "export type { GovernanceSurfaceV1 } from './governance/index.js'",
    }, async (_entryFile, fixtureRoot) => assertMainEntryGraphIsIsolated([
      ['source', resolve(fixtureRoot, 'entry.ts')],
      ['runtime', resolve(fixtureRoot, 'entry.js')],
      ['declaration', resolve(fixtureRoot, 'entry.d.ts')],
    ]))).rejects.toThrow()
  })

  it('detects renamed, namespace, and type-only governance module boundaries', () => {
    const syntheticMainEntry = [
      "export { sha256Canonical as renamedHash } from './governance/index.js'",
      "export * as governanceNamespace from './governance/index.js'",
      "export type { GovernanceSurfaceV1 as RenamedSurface } from './governance/index.js'",
      "import type * as GovernanceTypes from './governance/index.js'",
      "type GovernanceType = typeof import('./governance/index.js')",
      "type GovernanceModule = import('./governance/index.js')",
    ].join('\n')

    expect(extractGovernanceModuleSpecifiers(syntheticMainEntry)).toEqual([
      './governance/index.js',
      './governance/index.js',
      './governance/index.js',
      './governance/index.js',
      './governance/index.js',
      './governance/index.js',
    ])
  })

  it('extracts specifiers from every import boundary form', () => {
    const syntheticSource = [
      "import /* before clause */ { readFile } /* before source */ from /* before literal */ 'node:fs/promises'",
      "import /* before source */ 'node:fs'",
      "const runtime = import /* before paren */ ( /* before literal */ 'node:module' /* after literal */ )",
      "export { createHash } /* before source */ from /* before literal */ 'node:crypto'",
      "export * /* before source */ from /* before literal */ '@scope/provider'",
      "export * /* before source */ from /* before literal */ './unresolved-local.js'",
    ].join('\n')

    expect(extractImportSpecifiers(syntheticSource)).toEqual([
      'node:fs/promises',
      'node:fs',
      'node:module',
      'node:crypto',
      '@scope/provider',
      './unresolved-local.js',
    ])
  })

  it('rejects non-literal dynamic import specifiers', () => {
    expect(() => validateDynamicImportSpecifiers(
      'const runtime = import /* before paren */ ( /* before expression */ moduleName /* after expression */ )',
    )).toThrow('Dynamic import specifier must be a string literal')
  })

  it('rejects a nested forbidden external import reached through a local module', async () => {
    await expect(withSyntheticBuiltGraph({
      'entry.js': "export * from './nested.js'",
      'nested.js': "export { provider } from '@forbidden/provider'",
    }, (entryFile, fixtureRoot) => assertBuiltGovernanceExternalImportsAreAllowed(entryFile, fixtureRoot)))
      .rejects.toThrow()
  })

  it('rejects a local symlink that resolves outside the scanned package root', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-governance-outside-'))
    try {
      const outsideModule = resolve(outsideRoot, 'allowed.js')
      await writeFile(outsideModule, "export { createHash } from 'node:crypto'", 'utf8')

      await expect(withSyntheticBuiltGraph({
        'entry.js': "export * from './linked.js'",
        'linked.js': { symlink: outsideModule },
      }, (entryFile, fixtureRoot) => collectBuiltGovernanceExternalImports(entryFile, fixtureRoot)))
        .rejects.toThrow('outside the scanned package root')
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects a forbidden external import reached only through the declaration graph', async () => {
    await expect(withSyntheticBuiltGraph({
      'entry.js': "export * from './runtime.js'",
      'runtime.js': [
        "export { createHash } from 'node:crypto'",
        "export type { ObservationV1 } from '@ds-plugins/dsh-telemetry/contracts'",
      ].join('\n'),
      'entry.d.ts': "export * from './types.js'",
      'types.d.ts': "export type { Forbidden } from '@forbidden/types'",
    }, (entryFile, fixtureRoot) => assertBuiltGovernanceExternalImportsAreAllowed(entryFile, fixtureRoot)))
      .rejects.toThrow()
  })

  it('rejects a nested unresolved local import or re-export', async () => {
    await expect(withSyntheticBuiltGraph({
      'entry.js': "export * from './nested.js'",
      'nested.js': "export * from './missing.js'",
    }, (entryFile, fixtureRoot) => collectBuiltGovernanceExternalImports(entryFile, fixtureRoot)))
      .rejects.toThrow('Built governance import does not resolve: ./missing.js')
  })

  it('rejects a nested non-literal dynamic import', async () => {
    await expect(withSyntheticBuiltGraph({
      'entry.js': "export * from './nested.js'",
      'nested.js': 'export const load = (moduleName) => import(moduleName)',
    }, (entryFile, fixtureRoot) => collectBuiltGovernanceExternalImports(entryFile, fixtureRoot)))
      .rejects.toThrow('Dynamic import specifier must be a string literal')
  })

  it('builds compiled output before running package tests', async () => {
    const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(packageJson.scripts.test).toMatch(/^pnpm run build && /u)
  })

  it('keeps governance source limited to pure contract, hashing, and local barrel imports', async () => {
    const sources = await Promise.all([
      readFile(resolve(packageRoot, 'src/governance/contracts.ts'), 'utf8'),
      readFile(resolve(packageRoot, 'src/governance/canonical.ts'), 'utf8'),
      readFile(resolve(packageRoot, 'src/governance/admission.ts'), 'utf8'),
      readFile(resolve(packageRoot, 'src/governance/corpus.ts'), 'utf8'),
      readFile(resolve(packageRoot, 'src/governance/policy.ts'), 'utf8'),
      readFile(resolve(packageRoot, 'src/governance/index.ts'), 'utf8'),
    ])
    const imports = sources.flatMap(extractImportSpecifiers)

    expect(imports).toEqual(expect.arrayContaining([
      '@ds-plugins/dsh-telemetry/contracts',
      'node:crypto',
      './admission.js',
      './canonical.js',
      './contracts.js',
      './corpus.js',
      './policy.js',
      './resolver.js',
      './validate.js',
    ]))
    expect(new Set(imports)).toEqual(new Set([
      '@ds-plugins/dsh-telemetry/contracts',
      'node:crypto',
      './admission.js',
      './candidate-support.js',
      './canonical.js',
      './contracts.js',
      './corpus.js',
      './policy.js',
      './resolver.js',
      './validate.js',
    ]))
  })

  it('keeps the built governance transitive graph within the allowed external set', async () => {
    await assertBuiltGovernanceExternalImportsAreAllowed(
      resolve(packageRoot, 'lib/src/governance/index.js'),
    )
  })
})
