import {
  canonicalJson,
  type CandidateV1,
  type DatasetV1,
  type LessonV1,
} from '@ds-plugins/dsh-telemetry/contracts'
import { createHash } from 'node:crypto'
import { buildLessons } from './lessons.js'
import { mineFailures } from './miner.js'

const CANDIDATE_KINDS = ['skill', 'prompt', 'routing'] as const

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/**
 * Build inert change hypotheses for later authoring and evaluation.
 *
 * These proposals contain no deployable prompt, skill, or routing body and do
 * not write policy or artifacts. A deployable body requires a separately
 * reviewed content schema and evaluation gate.
 */
export function buildCandidates(lessons: LessonV1[], dataset: DatasetV1): CandidateV1[] {
  if (!Array.isArray(lessons)) throw new TypeError('lessons must be an array')

  const rebuiltLessons = buildLessons(mineFailures(dataset))
  const rebuiltByCanonical = new Map(rebuiltLessons.map(lesson => [canonicalJson(lesson), lesson]))
  const candidates = new Map<string, CandidateV1>()

  for (const input of lessons) {
    const lesson = rebuiltByCanonical.get(canonicalJson(input))
    if (lesson === undefined) continue

    for (const kind of CANDIDATE_KINDS) {
      const body: Omit<CandidateV1, 'id'> = {
        schemaVersion: 1,
        revision: 1,
        kind,
        status: 'proposed',
        lessonId: lesson.id,
        baseConfigHash: lesson.pattern.configHash,
        basePromptHash: lesson.pattern.promptHash,
        hypothesis: lesson.rule,
        evidence: lesson.pattern.evidence.map(item => ({ ...item })),
        evaluationRequired: true,
        autoPromote: false,
      }
      const candidate = { ...body, id: hash(body) }
      candidates.set(candidate.id, candidate)
    }
  }

  return [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id))
}
