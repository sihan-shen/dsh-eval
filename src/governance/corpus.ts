import { canonicalGovernanceJson, sha256Canonical } from './canonical.js'
import type { CorpusFixtureV1, CorpusManifestV1 } from './contracts.js'
import { validateCorpusManifestV1 } from './validate.js'

export type GovernanceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly GovernanceJsonValue[]
  | { readonly [key: string]: GovernanceJsonValue }

export type TemplateOfflineFixtureDefinitionV1 = Readonly<{
  fixtureId: string
  fixtureRevision: string
  pairingKey: string
  baseDomainRef: string
  variantDomainRef: string
  taskFamilyRef: string
  taskInstanceRef: string
  input: GovernanceJsonValue
}>

export type TemplateOfflineFixtureInputBodyV1 = Readonly<{
  schemaVersion: 1
  fixtureId: string
  fixtureRevision: string
  taskFamilyRef: string
  taskInstanceRef: string
  input: GovernanceJsonValue
}>

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

export type AuthoritativeCorpusManifestV1 = DeepReadonly<CorpusManifestV1>

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function identity(kind: 'domain' | 'task-family', name: string): string {
  return sha256Canonical({ schemaVersion: 1, kind, name })
}

function fixtureDefinition(
  fixtureId: string,
  fixtureRevision: string,
  pairingKey: string,
  baseDomain: string,
  variantDomain: string,
  taskFamily: string,
  input: GovernanceJsonValue,
): TemplateOfflineFixtureDefinitionV1 {
  const taskFamilyRef = identity('task-family', taskFamily)
  return {
    fixtureId,
    fixtureRevision,
    pairingKey,
    baseDomainRef: identity('domain', baseDomain),
    variantDomainRef: identity('domain', variantDomain),
    taskFamilyRef,
    taskInstanceRef: sha256Canonical({ schemaVersion: 1, taskFamilyRef, input }),
    input,
  }
}

export const TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS = deepFreeze([
  fixtureDefinition(
    'cross-domain-summary',
    '2',
    'cross-domain-summary',
    'typescript',
    'markdown',
    'incident-summary',
    {
      audience: 'maintainer',
      source: [
        'Cache misses increased after deploy.',
        'Rollback restored baseline.',
      ],
      task: 'Write a two-sentence incident summary.',
    },
  ),
  fixtureDefinition(
    'same-domain-edit',
    '1',
    'same-domain-edit',
    'typescript',
    'typescript',
    'template-edit',
    {
      language: 'typescript',
      request: 'Rename the exported function without changing behavior.',
      source: 'export function oldName(value: string): string { return value.trim() }',
    },
  ),
])

export const TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BODIES = deepFreeze(
  TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS.map((definition): TemplateOfflineFixtureInputBodyV1 => ({
    schemaVersion: 1,
    fixtureId: definition.fixtureId,
    fixtureRevision: definition.fixtureRevision,
    taskFamilyRef: definition.taskFamilyRef,
    taskInstanceRef: definition.taskInstanceRef,
    input: definition.input,
  })),
)

export const TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BYTES = deepFreeze(
  TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BODIES.map(canonicalGovernanceJson),
)

export const TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_DIGESTS = deepFreeze(
  TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BODIES.map(sha256Canonical),
)

const fixtures = TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS.map((definition, index): CorpusFixtureV1 => ({
  fixtureId: definition.fixtureId,
  fixtureRevision: definition.fixtureRevision,
  pairingKey: definition.pairingKey,
  baseDomainRef: definition.baseDomainRef,
  variantDomainRef: definition.variantDomainRef,
  taskFamilyRef: definition.taskFamilyRef,
  taskInstanceRef: definition.taskInstanceRef,
  fixtureInputDigest: TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_DIGESTS[index]!,
}))

export const TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BODY = deepFreeze({
  schemaVersion: 1 as const,
  corpusId: 'template-offline-v1-corpus' as const,
  corpusRevision: '1' as const,
  fixtures,
})

export const TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BYTES = canonicalGovernanceJson(
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BODY,
)

export const TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_DIGEST = sha256Canonical(
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BODY,
)

export const TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST: AuthoritativeCorpusManifestV1 = deepFreeze({
  ...TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BODY,
  corpusManifestDigest: TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_DIGEST,
})

const authoritativeManifestBytes = canonicalGovernanceJson(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST)

export function assertTemplateOfflineV1CorpusManifest(
  value: unknown,
): AuthoritativeCorpusManifestV1 {
  try {
    const validated = validateCorpusManifestV1(value)
    if (canonicalGovernanceJson(validated) !== authoritativeManifestBytes) throw new TypeError()
    return deepFreeze(validated)
  } catch {
    throw new TypeError('governance corpus manifest not authoritative')
  }
}
