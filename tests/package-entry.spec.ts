import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import * as entry from '@han_05/dsh-eval'

it('exposes the standalone evaluator entry and metadata', async () => {
  expect(entry).toHaveProperty('runBaseline')
  expect(entry).toHaveProperty('runOptimized')
  expect(entry).toHaveProperty('computeTelemetryMetrics')

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, unknown>
    files: string[]
  }
  expect(packageJson.exports['.']).toBeDefined()
  expect(packageJson.exports['./governance']).toBeDefined()
  expect(packageJson.files).toContain('fixtures/v0.2a/**')
})
