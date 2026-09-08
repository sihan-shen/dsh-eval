import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { assertSafeRepoPath, isIndexableFile, parseEvaluationTaskV1, sha256Utf8 } from '@han_05/dsh-context'
import type { EvaluationTaskV1, SymbolMatchV1 } from '@han_05/dsh-context'
import type { BaselineFileV1, BaselineRunOptionsV1, BaselineRunV1 } from './types.js'

const fixtureRoot = fileURLToPath(new URL(import.meta.url.includes('/lib/') ? '../../fixtures/v0.2a/repos/' : '../fixtures/v0.2a/repos/', import.meta.url))

type CheckedFixtureFileV1 = BaselineFileV1

function statSignature(stat: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
}

export async function readCheckedFixtureFile(repositoryRoot: string, path: string, maxBytes: number): Promise<CheckedFixtureFileV1> {
  const normalizedPath = assertSafeRepoPath(repositoryRoot, path)
  const absolutePath = resolve(repositoryRoot, ...normalizedPath.split('/'))
  const before = await lstat(absolutePath)
  if (before.isFile() && !before.isSymbolicLink() && before.size > maxBytes) throw new RangeError(`fixture file byte limit exceeded: ${normalizedPath}`)
  if (!isIndexableFile(normalizedPath, before, { maxBytes, nestedCheckoutRoots: ['upstream'] })) throw new Error(`fixture path is not indexable: ${normalizedPath}`)
  const text = await readFile(pathToFileURL(absolutePath), 'utf8')
  const after = await lstat(absolutePath)
  if (statSignature(before) !== statSignature(after)) throw new Error(`fixture path changed during read: ${normalizedPath}`)
  const byteLength = new TextEncoder().encode(text).byteLength
  if (byteLength > maxBytes) throw new RangeError(`fixture file byte limit exceeded: ${normalizedPath}`)
  return { path: normalizedPath, text, content_hash: sha256Utf8(text), byte_length: byteLength }
}

function symbolMatch(task: EvaluationTaskV1, file: BaselineFileV1, target: { path: string; name: string }, index: number): SymbolMatchV1 | null {
  if (target.path !== file.path) return null
  const offset = file.text.indexOf(target.name)
  if (offset < 0) return null
  const before = file.text.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - before.lastIndexOf('\n') - 1
  const endColumn = column + target.name.length
  return {
    symbolId: `${task.task_id}:${index}`,
    path: file.path,
    sourceHash: file.content_hash,
    start: { line, column },
    end: { line, column: endColumn },
    kind: 'symbol',
    name: target.name,
    score: 1 / (index + 1),
  }
}

export async function runBaseline(task: EvaluationTaskV1, options: BaselineRunOptionsV1 = {}): Promise<BaselineRunV1> {
  const parsedTask = parseEvaluationTaskV1(task)
  const runIndex = options.run_index ?? 1
  if (runIndex !== 1 && runIndex !== 2 && runIndex !== 3) throw new RangeError('run_index must be 1, 2, or 3')
  const files: BaselineFileV1[] = []
  let byteLength = 0
  for (const path of parsedTask.baseline_paths) {
    let file: BaselineFileV1
    try {
      file = await readCheckedFixtureFile(join(fixtureRoot, parsedTask.repository_shape), path, parsedTask.byte_limit)
    } catch (error) {
      if (error instanceof RangeError) throw error
      throw new Error(`fixture file cannot be read: ${path}`, { cause: error })
    }
    byteLength += file.byte_length
    if (byteLength > parsedTask.byte_limit) throw new RangeError(`baseline byte limit exceeded for ${parsedTask.task_id}`)
    files.push(file)
  }

  const sourceText = Object.fromEntries(files.map(file => [file.path, file.text]))
  const rankedResults = parsedTask.target_symbols
    .map((target, index) => symbolMatch(parsedTask, files.find(file => file.path === target.path) ?? files[0], target, index))
    .filter((match): match is SymbolMatchV1 => match !== null)

  return {
    task: parsedTask,
    revision: parsedTask.revision,
    ranked_results: rankedResults,
    source_text: sourceText,
    verifier_result: false,
    run_mode: 'baseline',
    cache_condition: 'none',
    run_index: runIndex,
    context_blocks_requested: files.length,
    cache_hits: 0,
    cache_misses: 0,
    selected_paths: parsedTask.baseline_paths,
    files,
  }
}

export async function runBaselineThreeTimes(task: EvaluationTaskV1): Promise<readonly [BaselineRunV1, BaselineRunV1, BaselineRunV1]> {
  const runs = await Promise.all([1, 2, 3].map(run_index => runBaseline(task, { run_index })))
  return runs as [BaselineRunV1, BaselineRunV1, BaselineRunV1]
}
