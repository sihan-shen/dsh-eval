import {
  canonicalJson,
  FAILURE_CLASSES,
  type FailureClassV1,
  type LessonV1,
  type PatternV1,
} from '@han_05/dsh-telemetry/contracts'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const REF_PATTERN = /^[0-9a-f]{64}$/u

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function assertRef(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a 64-character lowercase hexadecimal reference`)
  }
}

function assertArrayBounds(value: unknown[], minimum: number, maximum: number, path: string): void {
  if (value.length < minimum || value.length > maximum) {
    throw new TypeError(`${path} support must contain between ${minimum} and ${maximum} entries`)
  }
}

function assertSortedUnique(values: string[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1].localeCompare(values[index]) >= 0) {
      throw new TypeError(`${path} support must be sorted and unique`)
    }
  }
}

function validatedPattern(value: PatternV1): PatternV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('pattern must be an object')
  const keys = Object.keys(value).sort()
  const expectedKeys = [
    'category', 'configHash', 'domainRef', 'evidence', 'id', 'promptHash',
    'runRefs', 'schemaVersion', 'taskFamilyRef', 'taskInstanceRefs',
  ].sort()
  if (canonicalJson(keys) !== canonicalJson(expectedKeys)) throw new TypeError('pattern fields are invalid')
  if (value.schemaVersion !== 1) throw new TypeError('pattern schemaVersion must be 1')
  if (!FAILURE_CLASSES.includes(value.category as FailureClassV1)) throw new TypeError('pattern category is unsupported')
  assertRef(value.domainRef, 'pattern domainRef')
  assertRef(value.taskFamilyRef, 'pattern taskFamilyRef')
  assertRef(value.configHash, 'pattern configHash')
  assertRef(value.promptHash, 'pattern promptHash')
  assertRef(value.id, 'pattern id')
  if (!Array.isArray(value.runRefs) || !Array.isArray(value.taskInstanceRefs) || !Array.isArray(value.evidence)) {
    throw new TypeError('pattern support must use arrays')
  }
  assertArrayBounds(value.runRefs, 3, 32, 'pattern runRefs')
  assertArrayBounds(value.taskInstanceRefs, 2, 32, 'pattern taskInstanceRefs')
  assertArrayBounds(value.evidence, 3, 32, 'pattern evidence')
  const runRefs = value.runRefs.map((runRef, index) => {
    assertRef(runRef, `pattern runRefs[${index}]`)
    return runRef
  })
  const taskInstanceRefs = value.taskInstanceRefs.map((taskRef, index) => {
    assertRef(taskRef, `pattern taskInstanceRefs[${index}]`)
    return taskRef
  })
  assertSortedUnique(runRefs, 'pattern runRefs')
  assertSortedUnique(taskInstanceRefs, 'pattern taskInstanceRefs')
  const evidence = value.evidence.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item) ||
      canonicalJson(Object.keys(item).sort()) !== canonicalJson(['runRef', 'seq'])) {
      throw new TypeError(`pattern evidence[${index}] is invalid`)
    }
    assertRef(item.runRef, `pattern evidence[${index}].runRef`)
    if (!Number.isSafeInteger(item.seq) || item.seq < 0) throw new TypeError(`pattern evidence[${index}].seq is invalid`)
    return { runRef: item.runRef, seq: item.seq }
  })
  const supportedRuns = new Set(runRefs)
  const evidencedRuns = new Set<string>()
  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index]
    if (!supportedRuns.has(item.runRef)) throw new TypeError(`pattern evidence[${index}] must reference a supporting run`)
    evidencedRuns.add(item.runRef)
    if (index > 0) {
      const prior = evidence[index - 1]
      if (prior.runRef.localeCompare(item.runRef) > 0 || (prior.runRef === item.runRef && prior.seq >= item.seq)) {
        throw new TypeError('pattern evidence must be sorted and unique')
      }
    }
  }
  if (evidencedRuns.size !== runRefs.length) throw new TypeError('pattern evidence must cover every supporting run')
  const body: Omit<PatternV1, 'id'> = {
    schemaVersion: 1,
    category: value.category,
    domainRef: value.domainRef,
    taskFamilyRef: value.taskFamilyRef,
    configHash: value.configHash,
    promptHash: value.promptHash,
    runRefs,
    taskInstanceRefs,
    evidence,
  }
  if (hash(body) !== value.id) throw new TypeError('pattern id does not match its content')
  return { ...body, id: value.id }
}

function ruleFor(category: FailureClassV1): LessonV1['rule'] {
  if (category === 'context_loss' || category === 'insufficient_context' || category === 'context_bloat') {
    return 'review-context-boundary'
  }
  if (category === 'verification_gap') return 'review-verification-scope'
  if (category === 'wrong_model' || category === 'bad_routing' || category === 'prompt_incompatibility') {
    return 'review-route-fit'
  }
  return 'review-failure-evidence'
}

function validatedLesson(value: LessonV1): LessonV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(['id', 'pattern', 'revision', 'rule', 'schemaVersion'])) {
    throw new TypeError('lesson fields are invalid')
  }
  if (value.schemaVersion !== 1 || value.revision !== 1) throw new TypeError('lesson schema or revision is unsupported')
  assertRef(value.id, 'lesson id')
  const pattern = validatedPattern(value.pattern)
  const rule = ruleFor(pattern.category)
  if (value.rule !== rule) throw new TypeError('lesson rule does not match its pattern')
  const body: Omit<LessonV1, 'id'> = { schemaVersion: 1, revision: 1, pattern, rule }
  if (hash(body) !== value.id) throw new TypeError('lesson id does not match its content')
  return { ...body, id: value.id }
}

/** Convert validated failure patterns into deterministic version-one lessons. */
export function buildLessons(patterns: PatternV1[]): LessonV1[] {
  if (!Array.isArray(patterns)) throw new TypeError('patterns must be an array')
  const lessons = patterns.map(input => {
    const pattern = validatedPattern(input)
    const body: Omit<LessonV1, 'id'> = {
      schemaVersion: 1,
      revision: 1,
      pattern,
      rule: ruleFor(pattern.category),
    }
    return { ...body, id: hash(body) }
  })
  return lessons.sort((left, right) => left.id.localeCompare(right.id))
}

async function assertPrivateDirectory(root: string): Promise<void> {
  let stats
  try {
    stats = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(root, { mode: 0o700 })
    stats = await lstat(root)
  }
  if (stats.isSymbolicLink()) throw new TypeError('lesson root must not be a symlink')
  if (!stats.isDirectory()) throw new TypeError('lesson root must be a directory')
  if ((stats.mode & 0o077) !== 0) throw new TypeError('lesson root must be private')
}

/** Store one canonical lesson without overwriting any existing artifact. */
export async function writeLesson(root: string, input: LessonV1): Promise<void> {
  if (!isAbsolute(root)) throw new TypeError('lesson root must be absolute')
  const lesson = validatedLesson(input)
  await assertPrivateDirectory(root)
  const path = join(root, `${lesson.id}.json`)
  const bytes = `${canonicalJson(lesson)}\n`
  let handle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes, 'utf8')
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new TypeError('lesson file must not be a symlink')
    if (!stats.isFile()) throw new TypeError('lesson path must be a regular file')
    if ((stats.mode & 0o077) !== 0) throw new TypeError('lesson file must be private')
    if (stats.size !== Buffer.byteLength(bytes, 'utf8')) throw new TypeError('conflicting lesson bytes')
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (await existing.readFile('utf8') !== bytes) throw new TypeError('conflicting lesson bytes')
    } finally {
      await existing.close()
    }
  } finally {
    await handle?.close()
  }
}
