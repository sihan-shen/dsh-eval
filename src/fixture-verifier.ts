import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseEvaluationTaskV1 } from '@ds-plugins/dsh-context'
import type { EvaluationTaskV1 } from '@ds-plugins/dsh-context'
import type { BaselineRunV1, RetrievalRunV1 } from './types.js'
import { readCheckedFixtureFile } from './baseline.js'

const fixtureRoot = fileURLToPath(new URL(import.meta.url.includes('/lib/') ? '../../fixtures/v0.2a/repos/' : '../fixtures/v0.2a/repos/', import.meta.url))

const manifestPath = join(fixtureRoot, '..', 'manifest.json')
const fixtureManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { revision?: string; fixture_hashes?: Record<string, string> }
const fixedFixtureHashes: Readonly<Record<string, string>> = fixtureManifest.fixture_hashes ?? {}

type VerifiableResult = RetrievalRunV1 & {
  readonly files: readonly { path: string; text: string; content_hash: string; byte_length: number }[]
}

export async function runFixtureVerifier(task: EvaluationTaskV1, result: VerifiableResult | BaselineRunV1): Promise<boolean> {
  let parsedTask: EvaluationTaskV1
  try {
    parsedTask = parseEvaluationTaskV1(task)
  } catch {
    return false
  }
  if (fixtureManifest.revision === undefined || parsedTask.revision !== fixtureManifest.revision) return false
  if (parsedTask.verifier.id !== 'fixture-integrity-v1' || parsedTask.verifier.expected_revision !== parsedTask.revision) return false
  if (!Array.isArray(result.files)) return false
  const resultFiles = new Map<string, VerifiableResult['files'][number]>()
  for (const file of result.files) {
    if (resultFiles.has(file.path)) return false
    resultFiles.set(file.path, file)
  }
  const repositoryRoot = join(fixtureRoot, parsedTask.repository_shape)
  for (const path of parsedTask.verifier.required_paths) {
    const file = resultFiles.get(path)
    if (!file) return false
    let expectedFile
    try {
      expectedFile = await readCheckedFixtureFile(repositoryRoot, path, parsedTask.byte_limit)
    } catch {
      return false
    }
    const expectedText = expectedFile.text
    const fixtureKey = `${parsedTask.repository_shape}/${path}`
    const expectedHash = fixedFixtureHashes[fixtureKey]
    if (expectedHash === undefined) return false
    if (expectedFile.content_hash !== expectedHash || file.text !== expectedText || file.content_hash !== expectedHash || file.byte_length !== expectedFile.byte_length) return false
  }
  return result.revision === parsedTask.revision
}
