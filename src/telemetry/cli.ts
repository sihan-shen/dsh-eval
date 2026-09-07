import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalJson, parseRunAnnotationV1, parseTelemetryRecordV1, type DatasetV1 } from '@ds-plugins/dsh-telemetry/contracts'
import { buildCandidates } from './candidates.js'
import { parseDatasetV1, getValidatedCompleteRunsV1 } from './dataset.js'
import { computeTelemetryMetrics } from './metrics.js'
import { calibrateModels } from './calibration.js'
import { buildLessons, writeLesson } from './lessons.js'
import { mineFailures } from './miner.js'

const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_ANNOTATION_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 8_192
const MAX_RECORDS = 65_536
const MAX_ANNOTATIONS = 4_096
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_FILES = 4096
const SEGMENT = /^segment-\d{16}\.jsonl$/u
const fail = (message: string): never => { throw new Error(message) }

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function json(value: unknown): string { return `${canonicalJson(value)}\n` }
async function ensureAbsent(path: string): Promise<void> {
  try { await lstat(path); fail('output already exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
async function privateRegular(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('telemetry input is not a private regular file')
}
async function readBounded(
  path: string,
  maximum: number,
  aggregate?: { bytes: number; maximum: number },
): Promise<Buffer> {
  if (!isAbsolute(path)) fail('input paths must be absolute')
  await privateRegular(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0) fail('telemetry input is not a private regular file')
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const remaining = Math.min(maximum - total, aggregate === undefined ? maximum : aggregate.maximum - aggregate.bytes)
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (aggregate !== undefined) aggregate.bytes += bytesRead
      if (total > maximum) fail('input exceeds byte limit')
      if (aggregate !== undefined && aggregate.bytes > aggregate.maximum) fail('telemetry input exceeds byte limit')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total)
  } finally { await handle.close() }
}
function parseJsonLines(bytes: Buffer, label: string, admission = { records: 0 }): unknown[] {
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) fail(`${label} has truncated final line`)
  const rows: unknown[] = []
  let start = 0
  let lineNumber = 1
  while (start < bytes.byteLength) {
    const end = bytes.indexOf(0x0a, start)
    if (end - start + 1 > MAX_RECORD_BYTES) fail(`${label} line ${lineNumber} exceeds byte limit`)
    if (end > start) {
      admission.records += 1
      if (admission.records > MAX_RECORDS) fail(`telemetry record count exceeds ${MAX_RECORDS}`)
      try { rows.push(JSON.parse(bytes.toString('utf8', start, end))) } catch { fail(`${label} has invalid line ${lineNumber}`) }
    }
    start = end + 1
    lineNumber += 1
  }
  return rows
}
function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}
function enforceAnnotationCount(bytes: Buffer): void {
  let index = 0
  while (index < bytes.byteLength && isJsonWhitespace(bytes[index])) index += 1
  if (bytes[index] !== 0x5b) return
  let count = 0
  let depth = 1
  let escaped = false
  let inString = false
  let expectingValue = true
  for (index += 1; index < bytes.byteLength && depth > 0; index += 1) {
    const byte = bytes[index]
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true
      else if (byte === 0x22) inString = false
      continue
    }
    if (depth === 1 && expectingValue && !isJsonWhitespace(byte)) {
      if (byte === 0x5d) { depth = 0; continue }
      if (byte === 0x2c) continue
      count += 1
      if (count > MAX_ANNOTATIONS) fail(`annotation count exceeds ${MAX_ANNOTATIONS}`)
      expectingValue = false
    }
    if (byte === 0x22) inString = true
    else if (byte === 0x5b || byte === 0x7b) depth += 1
    else if (byte === 0x5d || byte === 0x7d) depth -= 1
    else if (depth === 1 && byte === 0x2c) expectingValue = true
  }
}
async function acquireLock(root: string): Promise<{ close: () => Promise<void> }> {
  const path = join(root, 'writer.lock')
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const identity = await handle.stat()
  return { close: async () => {
    await handle.close()
    try {
      const current = await lstat(path)
      if (current.dev === identity.dev && current.ino === identity.ino) await rm(path)
    } catch { /* the lock may already have been recovered */ }
  } }
}
async function exportStore(store: string, out: string): Promise<void> {
  if (!isAbsolute(store) || !isAbsolute(out)) fail('store and output paths must be absolute')
  await ensureAbsent(out)
  const root = resolve(store)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0) fail('store must be a private directory')
  const lock = await acquireLock(root)
  try {
    const names = (await readdir(root)).filter(name => SEGMENT.test(name)).sort()
    let total = 0
    const inputAdmission = { bytes: 0, maximum: MAX_INPUT_BYTES }
    const recordAdmission = { records: 0 }
    const chunks: Buffer[] = []
    for (const name of names) {
      const path = join(root, name)
      const bytes = await readBounded(path, 1024 * 1024, inputAdmission)
      const rows = parseJsonLines(bytes, name, recordAdmission)
      for (const row of rows) {
        const record = parseTelemetryRecordV1(row)
        const line = Buffer.from(json(record))
        total += line.byteLength
        if (total > MAX_OUTPUT_BYTES) fail('export exceeds output byte limit')
        chunks.push(line)
      }
    }
    await ensureAbsent(out)
    await writeFile(out, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' })
  } finally { await lock.close() }
}
async function writeArtifact(path: string, value: unknown, state: { bytes: number; files: number }): Promise<void> {
  const content = Buffer.from(json(value))
  state.bytes += content.byteLength; state.files += 1
  if (state.bytes > MAX_OUTPUT_BYTES || state.files > MAX_OUTPUT_FILES) fail('analysis output exceeds artifact limits')
  await writeFile(path, content, { mode: 0o600, flag: 'wx' })
}
async function analyze(eventsPath: string, annotationsPath: string, out: string): Promise<void> {
  if (!isAbsolute(out)) fail('output path must be absolute')
  await ensureAbsent(out)
  const eventsBytes = await readBounded(eventsPath, MAX_INPUT_BYTES)
  const annotationsBytes = await readBounded(annotationsPath, MAX_ANNOTATION_BYTES)
  const records = parseJsonLines(eventsBytes, 'events')
  enforceAnnotationCount(annotationsBytes)
  const annotationValues = JSON.parse(annotationsBytes.toString('utf8'))
  if (!Array.isArray(annotationValues)) fail('annotations must be an array')
  annotationValues.forEach((value: unknown) => parseRunAnnotationV1(value))
  const dataset = parseDatasetV1(records, annotationValues)
  const patterns = mineFailures(dataset)
  const lessons = buildLessons(patterns)
  const candidates = buildCandidates(lessons, dataset)
  const completeRuns = getValidatedCompleteRunsV1(dataset)
  const unknownRuns = completeRuns.filter(run => run.annotation === null || run.annotation.outcome === 'unknown').length
  const incompleteRuns = new Set(dataset.records.map(record => `${record.domainRef}:${record.runRef}`)).size - completeRuns.length
  const stage = await import('node:fs/promises').then(fs => fs.mkdtemp(join(dirname(out), '.dsh-analysis-')))
  const state = { bytes: 0, files: 0 }
  try {
    await mkdir(join(stage, 'lessons'), { mode: 0o700 }); await mkdir(join(stage, 'candidates'), { mode: 0o700 })
    await writeArtifact(join(stage, 'metrics.json'), computeTelemetryMetrics(dataset), state)
    await writeArtifact(join(stage, 'patterns.json'), patterns, state)
    await writeArtifact(join(stage, 'calibration.json'), calibrateModels(dataset), state)
    for (const lesson of lessons) await writeArtifact(join(stage, 'lessons', `${lesson.id}.json`), lesson, state)
    for (const candidate of candidates) await writeArtifact(join(stage, 'candidates', `${candidate.id}.json`), candidate, state)
    const manifest = {
      schemaVersion: 1,
      eventsSha256: digest(eventsBytes),
      annotationsSha256: digest(annotationsBytes),
      recordCount: dataset.records.length,
      annotationCount: dataset.annotations.length,
      completeRunCount: completeRuns.length,
      unknownRunCount: unknownRuns,
      incompleteRunCount: Math.max(0, incompleteRuns),
    }
    await writeArtifact(join(stage, 'manifest.json'), manifest, state)
    await rename(stage, out)
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}
function value(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  if (index < 0 || args[index + 1] === undefined || args[index + 1].startsWith('--')) fail(`missing ${flag}`)
  return args[index + 1]
}
function processError(args: string[]): string {
  const command = args[0]
  if (command !== 'analyze' && command !== 'export') return 'TELEMETRY_CLI_ERROR INVALID_ARGUMENT command'
  const required = command === 'analyze' ? ['--events', '--annotations', '--out'] : ['--store', '--out']
  const missing = required.some(flag => {
    const index = args.indexOf(flag)
    return index < 0 || args[index + 1] === undefined || args[index + 1].startsWith('--')
  })
  return `TELEMETRY_CLI_ERROR ${missing ? 'INVALID_ARGUMENT' : 'COMMAND_FAILED'} ${command}`
}
export async function runCli(args: string[]): Promise<void> {
  const command = args[0]
  if (command === 'export') return exportStore(value(args, '--store'), value(args, '--out'))
  if (command === 'analyze') return analyze(value(args, '--events'), value(args, '--annotations'), value(args, '--out'))
  fail('unknown command')
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  runCli(args).catch(() => { process.stderr.write(`${processError(args)}\n`); process.exitCode = 1 })
}
