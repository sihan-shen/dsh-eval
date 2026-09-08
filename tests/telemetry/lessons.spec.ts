import { canonicalJson, FAILURE_CLASSES, type FailureClassV1, type PatternV1 } from '@han_05/dsh-telemetry/contracts'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLessons, writeLesson } from '../../src/telemetry/lessons.js'
import { ref } from './fixture.js'

function pattern(category: FailureClassV1 = 'tool_misuse', runRefs = [ref('5'), ref('6'), ref('7')]): PatternV1 {
  const body: Omit<PatternV1, 'id'> = {
    schemaVersion: 1,
    category,
    domainRef: ref('d'),
    taskFamilyRef: ref('2'),
    configHash: ref('3'),
    promptHash: ref('4'),
    runRefs,
    taskInstanceRefs: [ref('8'), ref('9')],
    evidence: runRefs.map(runRef => ({ runRef, seq: 1 })),
  }
  const id = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')
  return { ...body, id }
}

function withPatternId(body: Omit<PatternV1, 'id'>): PatternV1 {
  return { ...body, id: createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex') }
}

describe('buildLessons', () => {
  it('maps every failure category to its review rule', () => {
    const expected: Record<FailureClassV1, string> = {
      context_loss: 'review-context-boundary',
      insufficient_context: 'review-context-boundary',
      context_bloat: 'review-context-boundary',
      verification_gap: 'review-verification-scope',
      wrong_model: 'review-route-fit',
      bad_routing: 'review-route-fit',
      prompt_incompatibility: 'review-route-fit',
      bad_reasoning: 'review-failure-evidence',
      tool_misuse: 'review-failure-evidence',
      premature_edit: 'review-failure-evidence',
      implementation_error: 'review-failure-evidence',
      scope_creep: 'review-failure-evidence',
      bad_handoff: 'review-failure-evidence',
      provider_failure: 'review-failure-evidence',
      budget_exhaustion: 'review-failure-evidence',
    }
    const lessons = buildLessons(FAILURE_CLASSES.map(category => pattern(category)))
    expect(Object.fromEntries(lessons.map(lesson => [lesson.pattern.category, lesson.rule]))).toEqual(expected)
    expect(lessons.every(lesson => lesson.schemaVersion === 1 && lesson.revision === 1)).toBe(true)
  })

  it('is deterministic and changes the lesson id when support changes', () => {
    const first = pattern()
    const second = pattern('verification_gap')
    expect(buildLessons([second, first])).toEqual(buildLessons([first, second]))

    const original = buildLessons([first])[0]
    const changed = buildLessons([pattern('tool_misuse', [...first.runRefs, ref('a')])])[0]
    expect(original.id).toMatch(/^[0-9a-f]{64}$/u)
    expect(changed.id).not.toBe(original.id)
  })

  it('rejects a pattern whose content does not match its id', () => {
    expect(() => buildLessons([{ ...pattern(), id: ref('0') }])).toThrow(/pattern.*id/i)
  })

  it('rejects matching-id patterns with unbounded or invalid support structure', () => {
    const valid = pattern()
    const { id: _id, ...validBody } = valid
    const tooManyRuns = Array.from({ length: 33 }, (_, index) => index.toString(16).padStart(64, '0'))
    const cases: PatternV1[] = [
      withPatternId({ ...validBody, runRefs: tooManyRuns, evidence: valid.evidence }),
      withPatternId({ ...validBody, runRefs: [valid.runRefs[0], valid.runRefs[0], valid.runRefs[2]] }),
      withPatternId({ ...validBody, taskInstanceRefs: [valid.taskInstanceRefs[1], valid.taskInstanceRefs[0]] }),
      withPatternId({ ...validBody, evidence: [{ runRef: ref('a'), seq: 1 }] }),
    ]
    for (const invalid of cases) expect(() => buildLessons([invalid])).toThrow(/pattern.*support|pattern.*evidence/i)
  })
})

describe('writeLesson', () => {
  it('writes canonical private bytes and accepts an identical retry', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-lessons-'))
    const root = join(parent, 'private')
    const lesson = buildLessons([pattern()])[0]
    await writeLesson(root, lesson)
    const path = join(root, `${lesson.id}.json`)
    const bytes = await readFile(path, 'utf8')

    await writeLesson(root, lesson)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(bytes).toBe(`${canonicalJson(lesson)}\n`)
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
  })

  it('refuses conflicting preexisting bytes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-lessons-'))
    const root = join(parent, 'private')
    await mkdir(root, { mode: 0o700 })
    const lesson = buildLessons([pattern()])[0]
    await writeFile(join(root, `${lesson.id}.json`), '{}\n', { mode: 0o600 })
    await expect(writeLesson(root, lesson)).rejects.toThrow(/conflict/i)
  })

  it('rejects a wrong-size conflict before trying to read its bytes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-lessons-'))
    const root = join(parent, 'private')
    await mkdir(root, { mode: 0o700 })
    const lesson = buildLessons([pattern()])[0]
    const path = join(root, `${lesson.id}.json`)
    await writeFile(path, '{}\n', { mode: 0o600 })
    await chmod(path, 0o000)
    await expect(writeLesson(root, lesson)).rejects.toThrow(/conflict/i)
  })

  it('refuses to trust an existing lesson file that is not private', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-lessons-'))
    const root = join(parent, 'private')
    const lesson = buildLessons([pattern()])[0]
    await writeLesson(root, lesson)
    const path = join(root, `${lesson.id}.json`)
    await chmod(path, 0o644)
    await expect(writeLesson(root, lesson)).rejects.toThrow(/private/i)
  })

  it('rejects forged ids, relative roots and symlinks', async () => {
    const lesson = buildLessons([pattern()])[0]
    await expect(writeLesson('relative', lesson)).rejects.toThrow(/absolute/i)
    await expect(writeLesson(join(tmpdir(), 'ignored'), { ...lesson, id: ref('0') })).rejects.toThrow(/lesson.*id/i)

    const parent = await mkdtemp(join(tmpdir(), 'dsh-lessons-'))
    const real = join(parent, 'real')
    const linked = join(parent, 'linked')
    await mkdir(real, { mode: 0o700 })
    await chmod(real, 0o700)
    await symlink(real, linked)
    await expect(writeLesson(linked, lesson)).rejects.toThrow(/symlink/i)

    const fileLinkRoot = join(parent, 'file-link-root')
    await mkdir(fileLinkRoot, { mode: 0o700 })
    await symlink(join(parent, 'missing-target'), join(fileLinkRoot, `${lesson.id}.json`))
    await expect(writeLesson(fileLinkRoot, lesson)).rejects.toThrow(/symlink|conflict/i)
  })
})
