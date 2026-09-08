import { readFileSync } from 'node:fs'
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  canonicalJson,
  parseSymbolQueryResultV1,
  parseEvaluationTaskV1,
  type EvaluationRecordV1,
  type EvaluationTaskV1,
  type SymbolMatchV1,
} from '@han_05/dsh-context'
import {
  buildSymbolIndex,
  apply as applyCodeIntelligence,
  type ContextCompilerHandle,
  extractFallbackSymbols,
  querySymbols,
  RepositorySnapshotStore,
} from '@han_05/dsh-code-intelligence'
import { computeRetrievalMetrics } from './metrics.js'
import { runFixtureVerifier } from './fixture-verifier.js'
import { estimateSourceTokensV1 } from './tokenizer.js'
import type { BaselineFileV1, RetrievalRunV1, SourceMeasurementV1 } from './types.js'

const fixtureRoot = fileURLToPath(new URL(import.meta.url.includes('/lib/') ? '../../fixtures/v0.2a/repos/' : '../fixtures/v0.2a/repos/', import.meta.url))
const manifestPath = join(fixtureRoot, '..', 'manifest.json')
const fixedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly tasks: readonly EvaluationTaskV1[] }

const MAX_FILES = 10_000
const MAX_TOTAL_BYTES = 67_108_864
const MAX_DIRECTORIES = 20_000
const MAX_IGNORE_BYTES = 262_144

type OptimizedCacheProtocolState = {
  readonly root: string
  readonly warmRepositories: Map<string, string>
  readonly warmCompilers: Map<string, MountedEvaluationCompiler>
  readonly preparedWarmQueries: Set<string>
  queue: Promise<void>
  disposed: boolean
}

export type OptimizedCacheProtocol = {
  dispose(): Promise<void>
}

const protocolStates = new WeakMap<OptimizedCacheProtocol, OptimizedCacheProtocolState>()

export async function createOptimizedCacheProtocol(): Promise<OptimizedCacheProtocol> {
  const state: OptimizedCacheProtocolState = {
    root: await mkdtemp(join(tmpdir(), 'dsh-optimized-cache-')),
    warmRepositories: new Map(),
    warmCompilers: new Map(),
    preparedWarmQueries: new Set(),
    queue: Promise.resolve(),
    disposed: false,
  }
  const protocol: OptimizedCacheProtocol = Object.freeze({
    async dispose(): Promise<void> {
      if (state.disposed) return
      state.disposed = true
      await state.queue
      await Promise.all([...state.warmCompilers.values()].map(mounted => mounted.dispose()))
      await rm(state.root, { recursive: true, force: true })
    },
  })
  protocolStates.set(protocol, state)
  return protocol
}

async function serializedProtocolRun<T>(protocol: OptimizedCacheProtocol, operation: (state: OptimizedCacheProtocolState) => Promise<T>): Promise<T> {
  const state = protocolStates.get(protocol)
  if (state === undefined) throw new TypeError('optimized cache protocol was not created by createOptimizedCacheProtocol')
  if (state.disposed) throw new Error('optimized cache protocol is disposed')
  const previous = state.queue
  let release!: () => void
  state.queue = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    if (state.disposed) throw new Error('optimized cache protocol is disposed')
    return await operation(state)
  } finally {
    release()
  }
}

async function copyFixtureRepository(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: path => basename(path) !== '.dsh-context-cache',
  })
  await appendFile(join(destination, '.gitignore'), '\n.dsh-context-cache\n.dsh-context-cache/**\n', 'utf8')
}

async function repositoryForRun(state: OptimizedCacheProtocolState, task: EvaluationTaskV1, condition: 'cold' | 'warm'): Promise<string> {
  const source = join(fixtureRoot, task.repository_shape)
  if (condition === 'cold') {
    const parent = await mkdtemp(join(state.root, 'cold-'))
    const destination = join(parent, task.repository_shape)
    await copyFixtureRepository(source, destination)
    return destination
  }
  const existing = state.warmRepositories.get(task.repository_shape)
  if (existing !== undefined) return existing
  const destination = join(state.root, 'warm', task.repository_shape)
  await mkdir(join(state.root, 'warm'), { recursive: true })
  await copyFixtureRepository(source, destination)
  state.warmRepositories.set(task.repository_shape, destination)
  return destination
}

type MountedEvaluationCompiler = {
  readonly compiler: ContextCompilerHandle
  dispose(): Promise<void>
}

async function mountEvaluationCompiler(deploymentRoot: string, task: EvaluationTaskV1): Promise<MountedEvaluationCompiler> {
  let compiler: ContextCompilerHandle | undefined
  let effectDisposer: (() => void | Promise<void>) | undefined
  const ctx = {
    tools: { register() { return () => undefined } },
    provide(name: string, value: unknown) {
      if (name === 'contextCompiler') compiler = value as ContextCompilerHandle
      return () => {
        if (name === 'contextCompiler') compiler = undefined
      }
    },
    effect(effect: () => () => void | Promise<void>) {
      effectDisposer = effect()
      return effectDisposer
    },
  }
  await applyCodeIntelligence(ctx as never, snapshotConfig(deploymentRoot, task.revision, task.byte_limit))
  if (compiler === undefined || effectDisposer === undefined) throw new Error('v0.2c evaluator did not mount a context compiler')
  const mountedCompiler = compiler
  const dispose = effectDisposer
  return { compiler: mountedCompiler, async dispose() { await dispose() } }
}

function offsetAt(source: string, position: { readonly line: number; readonly column: number }): number {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column) || position.line < 1 || position.column < 0) throw new TypeError('symbol position is invalid')
  let line = 1
  let column = 0
  for (let offset = 0; offset < source.length; offset += 1) {
    if (line === position.line && column === position.column) return offset
    if (source[offset] === '\n') {
      line += 1
      column = 0
    } else {
      column += 1
    }
  }
  if (line === position.line && column === position.column) return source.length
  throw new RangeError('symbol position is outside source')
}

function positionAt(source: string, offset: number): { readonly line: number; readonly column: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new RangeError('source offset is invalid')
  let line = 1
  let column = 0
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1
      column = 0
    } else {
      column += 1
    }
  }
  return { line, column }
}

function nameRange(source: string, match: SymbolMatchV1): SymbolMatchV1 {
  const declarationStart = offsetAt(source, match.start)
  const declarationEnd = offsetAt(source, match.end)
  const nameOffset = source.indexOf(match.name, declarationStart)
  if (nameOffset < declarationStart || nameOffset + match.name.length > declarationEnd) throw new Error(`target declaration name is not within its indexed range: ${match.path}:${match.name}`)
  return { ...match, start: positionAt(source, nameOffset), end: positionAt(source, nameOffset + match.name.length) }
}

function snapshotConfig(deploymentRoot: string, revision: string, maxFileBytes: number) {
  return {
    deploymentRoot,
    revision,
    maxFileBytes,
    maxFiles: MAX_FILES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxDirectories: MAX_DIRECTORIES,
    maxIgnoreBytes: MAX_IGNORE_BYTES,
    nestedCheckoutRoots: [],
  } as const
}

function checkedTask(task: EvaluationTaskV1): EvaluationTaskV1 {
  const parsed = parseEvaluationTaskV1(task)
  const expected = fixedManifest.tasks.find(candidate => candidate.task_id === parsed.task_id)
  if (expected === undefined || canonicalJson(expected) !== canonicalJson(parsed)) throw new Error(`task is not the checked-in v0.2a manifest task: ${parsed.task_id}`)
  return parsed
}

async function fullVerifiedFiles(store: RepositorySnapshotStore, task: EvaluationTaskV1): Promise<BaselineFileV1[]> {
  const files: BaselineFileV1[] = []
  for (const path of task.verifier.required_paths) {
    const summary = store.snapshot.files.find(file => file.path === path)
    if (summary === undefined) throw new Error(`required fixture path is missing from snapshot: ${path}`)
    const text = await store.readVerifiedFile(path, summary.contentHash)
    files.push({ path, text, content_hash: summary.contentHash, byte_length: summary.byteLength })
  }
  return files
}

async function createOptimizedRun(
  taskInput: EvaluationTaskV1,
  condition: 'cold' | 'warm',
  runIndex: 1 | 2 | 3,
  deploymentRoot = join(fixtureRoot, taskInput.repository_shape),
  useCache = false,
  retainedCompiler?: MountedEvaluationCompiler,
): Promise<RetrievalRunV1> {
  const task = checkedTask(taskInput)
  if (runIndex !== 1 && runIndex !== 2 && runIndex !== 3) throw new RangeError('run_index must be 1, 2, or 3')
  const mounted = retainedCompiler ?? (useCache ? await mountEvaluationCompiler(deploymentRoot, task) : undefined)
  const ownsCompiler = mounted !== undefined && retainedCompiler === undefined
  const store = await RepositorySnapshotStore.create(snapshotConfig(deploymentRoot, task.revision, task.byte_limit))
  if (store.snapshot.revision !== task.revision) throw new Error(`snapshot revision mismatch for ${task.task_id}`)
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  let cacheHits = 0
  let cacheMisses = 0
  let query: ReturnType<typeof querySymbols>
  if (mounted !== undefined) {
    const before = mounted.compiler.cacheStats
    try {
      const block = await mounted.compiler.symbolQuery({ snapshotId: store.snapshot.snapshotId, query: task.query, limit: 50 }, new AbortController().signal)
      query = parseSymbolQueryResultV1(JSON.parse(block.text))
      const after = mounted.compiler.cacheStats
      cacheHits = after.hits - before.hits
      cacheMisses = after.misses - before.misses
    } finally {
      if (ownsCompiler) await mounted.dispose()
    }
  } else {
    query = querySymbols(store.snapshot, index, { query: task.query, limit: 50 })
  }
  const files = await fullVerifiedFiles(store, task)
  const targetKeys = new Set(task.target_symbols.map(target => `${target.path}:${target.name}`))
  const targetMatches = query.matches
    .filter(match => targetKeys.has(`${match.path}:${match.name}`))
    .sort((first, second) => Number(first.container !== undefined) - Number(second.container !== undefined) || first.start.line - second.start.line || first.start.column - second.start.column)
  const foundTargetKeys = new Set(targetMatches.map(match => `${match.path}:${match.name}`))
  if (foundTargetKeys.size !== targetKeys.size) throw new Error(`optimized query did not return every target for ${task.task_id}`)
  const selectedTargetIds = new Set<string>()
  const selectedTargetKeys = new Set<string>()
  for (const match of targetMatches) {
    const key = `${match.path}:${match.name}`
    if (!selectedTargetKeys.has(key)) {
      selectedTargetKeys.add(key)
      selectedTargetIds.add(match.symbolId)
    }
  }

  const measurements: SourceMeasurementV1[] = []
  const rankedResults: SymbolMatchV1[] = []
  const measuredTargetKeys = new Set<string>()
  for (const match of query.matches) {
    const file = files.find(candidate => candidate.path === match.path)
    if (file === undefined) {
      rankedResults.push(match)
      continue
    }
    const declarationStart = offsetAt(file.text, match.start)
    const declarationEnd = offsetAt(file.text, match.end)
    const target = selectedTargetIds.has(match.symbolId)
    const targetKey = `${match.path}:${match.name}`
    if (target && !measuredTargetKeys.has(targetKey)) {
      measuredTargetKeys.add(targetKey)
      measurements.push({
        path: match.path,
        source_hash: file.content_hash,
        start_offset: declarationStart,
        end_offset: declarationEnd,
        text: file.text.slice(declarationStart, declarationEnd),
        byte_length: new TextEncoder().encode(file.text.slice(declarationStart, declarationEnd)).byteLength,
      })
      rankedResults.push(nameRange(file.text, match))
    } else {
      rankedResults.push(match)
    }
  }
  if (measuredTargetKeys.size !== targetKeys.size) throw new Error(`optimized measurements are incomplete for ${task.task_id}`)
  const sourceTokenEstimate = estimateSourceTokensV1(measurements.map(measurement => measurement.text).join('\n'))
  return {
    task,
    revision: store.snapshot.revision,
    ranked_results: rankedResults,
    files,
    measurements,
    verifier_result: await runFixtureVerifier(task, {
      task,
      revision: store.snapshot.revision,
      ranked_results: rankedResults,
      files,
      measurements,
      verifier_result: false,
      run_mode: 'optimized',
      cache_condition: condition,
      run_index: runIndex,
      context_blocks_requested: measurements.length,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      uncached_source_tokens: cacheHits > 0 && cacheMisses === 0 ? 0 : sourceTokenEstimate,
    }),
    run_mode: 'optimized',
    cache_condition: condition,
    run_index: runIndex,
    context_blocks_requested: measurements.length,
    cache_hits: cacheHits,
    cache_misses: cacheMisses,
    uncached_source_tokens: cacheHits > 0 && cacheMisses === 0 ? 0 : sourceTokenEstimate,
  }
}

export async function runOptimized(
  task: EvaluationTaskV1,
  condition: 'cold' | 'warm',
  runIndex: 1 | 2 | 3,
  protocol?: OptimizedCacheProtocol,
): Promise<EvaluationRecordV1> {
  const run = protocol === undefined
    ? await createOptimizedRun(task, condition, runIndex)
    : await serializedProtocolRun(protocol, async state => {
        const checked = checkedTask(task)
        const deploymentRoot = await repositoryForRun(state, checked, condition)
        if (condition === 'warm') {
          const warmKey = canonicalJson({ repository_shape: checked.repository_shape, task_id: checked.task_id, query: checked.query })
          const compilerKey = canonicalJson({
            repository_shape: checked.repository_shape,
            revision: checked.revision,
            max_file_bytes: checked.byte_limit,
          })
          let mounted = state.warmCompilers.get(compilerKey)
          if (mounted === undefined) {
            mounted = await mountEvaluationCompiler(deploymentRoot, checked)
            state.warmCompilers.set(compilerKey, mounted)
          }
          if (!state.preparedWarmQueries.has(warmKey)) {
            const warmStore = await RepositorySnapshotStore.create(snapshotConfig(deploymentRoot, checked.revision, checked.byte_limit))
            await mounted.compiler.symbolQuery({ snapshotId: warmStore.snapshot.snapshotId, query: checked.query, limit: 50 }, new AbortController().signal)
            state.preparedWarmQueries.add(warmKey)
          }
          return createOptimizedRun(checked, condition, runIndex, deploymentRoot, true, mounted)
        }
        return createOptimizedRun(checked, condition, runIndex, deploymentRoot, true)
      })
  if (!run.verifier_result) throw new Error(`optimized fixture verification failed for ${run.task.task_id}`)
  return computeRetrievalMetrics(run)
}
