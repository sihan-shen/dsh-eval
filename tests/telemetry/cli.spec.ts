import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ref, observation, seal, annotation } from './fixture.js'
import { openTelemetryStore } from '@ds-plugins/dsh-telemetry/storage'
import { runCli } from '../../src/telemetry/cli.js'

const cli = fileURLToPath(new URL('../../lib/src/telemetry/cli.js', import.meta.url))
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

describe('telemetry CLI', () => {
  it('rejects missing and unknown commands', () => {
    const missing = run([])
    const unknown = run(['unknown'])
    const missingAnalyzeArgument = run(['analyze'])
    const missingExportArgument = run(['export'])
    expect(missing.error).toBeUndefined()
    expect(unknown.error).toBeUndefined()
    expect(missingAnalyzeArgument.error).toBeUndefined()
    expect(missingExportArgument.error).toBeUndefined()
    expect(missing.status).toBe(1)
    expect(missing.stderr).toBe('TELEMETRY_CLI_ERROR INVALID_ARGUMENT command\n')
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toBe('TELEMETRY_CLI_ERROR INVALID_ARGUMENT command\n')
    expect(unknown.stderr).not.toContain('unknown command')
    expect(missingAnalyzeArgument.status).toBe(1)
    expect(missingAnalyzeArgument.stderr).toBe('TELEMETRY_CLI_ERROR INVALID_ARGUMENT analyze\n')
    expect(missingExportArgument.status).toBe(1)
    expect(missingExportArgument.stderr).toBe('TELEMETRY_CLI_ERROR INVALID_ARGUMENT export\n')
  })

  it('does not expose rejected event content in process-facing errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-event-'))
    try {
      const sentinel = 'PRIVATE_EVENT_SENTINEL_8f96c5'
      const rejectedKey = `rejected_${sentinel}`
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      const runRef = ref('7')
      await writeFile(events, `${JSON.stringify({ ...observation(runRef, 1), [rejectedKey]: sentinel })}\n`, { mode: 0o600 })
      await writeFile(annotations, JSON.stringify([annotation(runRef)]), { mode: 0o600 })

      const result = run(['analyze', '--events', events, '--annotations', annotations, '--out', output])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toBe('TELEMETRY_CLI_ERROR COMMAND_FAILED analyze\n')
      expect(result.stderr).not.toContain(sentinel)
      expect(result.stderr).not.toContain(rejectedKey)
      expect(result.stderr).not.toContain('is not allowed')
      expect(result.stderr).not.toContain(events)
      expect(result.stderr).not.toContain(annotations)
      expect(result.stderr).not.toContain(output)
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('does not expose malformed annotation JSON in process-facing errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-annotation-'))
    try {
      const sentinel = 'PRIVATE_ANNOTATION_SENTINEL_c24d1a'
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      const runRef = ref('8')
      await writeFile(events, `${JSON.stringify(observation(runRef, 1))}\n`, { mode: 0o600 })
      await writeFile(annotations, `{"${sentinel}":}`, { mode: 0o600 })

      const result = run(['analyze', '--events', events, '--annotations', annotations, '--out', output])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toBe('TELEMETRY_CLI_ERROR COMMAND_FAILED analyze\n')
      expect(result.stderr).not.toContain(sentinel)
      expect(result.stderr).not.toContain('not valid JSON')
      expect(result.stderr).not.toContain(events)
      expect(result.stderr).not.toContain(annotations)
      expect(result.stderr).not.toContain(output)
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('does not expose absolute input paths from filesystem errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-path-'))
    try {
      const sentinel = 'PRIVATE_PATH_SENTINEL_a7639e'
      const events = join(dir, `${sentinel}.jsonl`)
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      await writeFile(annotations, '[]', { mode: 0o600 })

      const result = run(['analyze', '--events', events, '--annotations', annotations, '--out', output])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toBe('TELEMETRY_CLI_ERROR COMMAND_FAILED analyze\n')
      expect(result.stderr).not.toContain(sentinel)
      expect(result.stderr).not.toContain(events)
      expect(result.stderr).not.toContain(annotations)
      expect(result.stderr).not.toContain(output)
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('analyzes a valid bounded fixture and publishes all artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
    try {
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      const runRef = ref('1')
      await writeFile(events, `${JSON.stringify(observation(runRef, 1))}\n${JSON.stringify(seal(runRef, 1))}\n`, { mode: 0o600 })
      await writeFile(annotations, JSON.stringify([annotation(runRef)]), { mode: 0o600 })
      const result = run(['analyze', '--events', events, '--annotations', annotations, '--out', output])
      expect(result.status).toBe(0)
      expect(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).schemaVersion).toBe(1)
      expect(JSON.parse(await readFile(join(output, 'metrics.json'), 'utf8')).task_success_rate).toBeDefined()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('counts complete unannotated runs as unknown alongside annotated unknown outcomes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-manifest-'))
    try {
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      const annotatedUnknown = ref('a')
      const unannotated = ref('b')
      const incomplete = ref('c')
      await writeFile(events, [
        observation(annotatedUnknown, 1), seal(annotatedUnknown, 1),
        observation(unannotated, 1), seal(unannotated, 1),
        observation(incomplete, 1),
      ].map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
      await writeFile(annotations, JSON.stringify([annotation(annotatedUnknown, { outcome: 'unknown' })]), { mode: 0o600 })

      expect(run(['analyze', '--events', events, '--annotations', annotations, '--out', output]).status).toBe(0)
      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({
        recordCount: 5,
        annotationCount: 1,
        completeRunCount: 2,
        unknownRunCount: 2,
        incompleteRunCount: 1,
      })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects an oversized raw JSONL line before accepting its padded record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-line-limit-'))
    try {
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      const serialized = JSON.stringify(observation(ref('a'), 1))
      const padding = ' '.repeat(8_192 - Buffer.byteLength(serialized))
      await writeFile(events, `${serialized}${padding}\n`, { mode: 0o600 })
      await writeFile(annotations, '[]', { mode: 0o600 })

      await expect(runCli(['analyze', '--events', events, '--annotations', annotations, '--out', output]))
        .rejects.toThrow(/line.*byte limit/i)
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects over-limit counts before parsing excess values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-count-limit-'))
    try {
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const eventsOutput = join(dir, 'events-analysis')
      const annotationsOutput = join(dir, 'annotations-analysis')
      await writeFile(events, `${'{}\n'.repeat(65_536)}{bad}\n`, { mode: 0o600 })
      await writeFile(annotations, '[]', { mode: 0o600 })
      const eventsResult = runCli([
        'analyze', '--events', events, '--annotations', annotations, '--out', eventsOutput,
      ]).then(() => null, (error: unknown) => error)

      const boundedEvents = join(dir, 'bounded-events.jsonl')
      const excessAnnotations = join(dir, 'excess-annotations.json')
      await writeFile(boundedEvents, '', { mode: 0o600 })
      await writeFile(excessAnnotations, `[${new Array(4_097).fill('null').join(',')}]`, { mode: 0o600 })
      const annotationsResult = runCli([
        'analyze', '--events', boundedEvents, '--annotations', excessAnnotations, '--out', annotationsOutput,
      ]).then(() => null, (error: unknown) => error)

      const [eventsError, annotationsError] = await Promise.all([eventsResult, annotationsResult])
      expect(eventsError).toMatchObject({ message: expect.stringMatching(/record count.*65,?536/i) })
      expect(annotationsError).toMatchObject({ message: expect.stringMatching(/annotation count.*4,?096/i) })
      await expect(readFile(eventsOutput)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(annotationsOutput)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })


  it('exports sanitized numbered segments without salt or raw store files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
    try {
      const store = await openTelemetryStore(join(dir, 'store'))
      const runRef = ref('2')
      expect(store.enqueue(observation(runRef, 1))).toBe(true)
      await store.flush()
      await store.dispose()
      const output = join(dir, 'events.jsonl')
      const result = run(['export', '--store', join(dir, 'store'), '--out', output])
      expect(result.status).toBe(0)
      const exported = await readFile(output, 'utf8')
      expect(exported).toContain('run-started')
      expect(exported).not.toContain('salt.bin')
      expect(exported).not.toContain('writer.lock')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('does not expose rejected export segment content in process-facing errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-export-'))
    try {
      const sentinel = 'PRIVATE_EXPORT_SENTINEL_715cb2'
      const rejectedKey = `rejected_${sentinel}`
      const store = join(dir, 'store')
      const segment = join(store, 'segment-0000000000000000.jsonl')
      const output = join(dir, 'events.jsonl')
      const runRef = ref('9')
      await mkdir(store, { mode: 0o700 })
      await writeFile(segment, `${JSON.stringify({ ...observation(runRef, 1), [rejectedKey]: sentinel })}\n`, { mode: 0o600 })

      const result = run(['export', '--store', store, '--out', output])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toBe('TELEMETRY_CLI_ERROR COMMAND_FAILED export\n')
      expect(result.stderr).not.toContain(sentinel)
      expect(result.stderr).not.toContain(rejectedKey)
      expect(result.stderr).not.toContain('is not allowed')
      expect(result.stderr).not.toContain(store)
      expect(result.stderr).not.toContain(segment)
      expect(result.stderr).not.toContain(output)
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('does not leave a partial output directory on invalid input or overwrite existing output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
    try {
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      await writeFile(events, '{bad}\n', { mode: 0o600 })
      await writeFile(annotations, '[]', { mode: 0o600 })
      expect(run(['analyze', '--events', events, '--annotations', annotations, '--out', output]).status).not.toBe(0)
      await mkdir(output, { mode: 0o700 })
      expect(run(['analyze', '--events', events, '--annotations', annotations, '--out', output]).status).not.toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
