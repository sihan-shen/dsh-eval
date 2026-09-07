import { canonicalGovernanceJson, sha256Canonical } from './canonical.js'
import { TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_DIGEST } from './corpus.js'
import type { EvaluatorPolicyRefV1 } from './contracts.js'

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

const policyBody = {
  schemaVersion: 1 as const,
  policyId: 'template-offline-v1' as const,
  policyRevision: 1 as const,
  corpus: {
    corpusId: 'template-offline-v1-corpus' as const,
    corpusRevision: '1' as const,
    corpusManifestDigest: TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_DIGEST,
  },
  metrics: [
    {
      name: 'task_success_rate' as const,
      required: true,
      permittedBasis: ['observed' as const],
      minimumCoverage: 1,
      formula: 'successful-known-outcomes/known-outcomes' as const,
      direction: 'higher' as const,
      threshold: { deltaGte: 0 },
      zeroDenominator: 'required-unavailable' as const,
    },
    {
      name: 'accepted_result_rate' as const,
      required: true,
      permittedBasis: ['observed' as const],
      minimumCoverage: 1,
      formula: 'accepted-true/explicit-acceptance' as const,
      direction: 'higher' as const,
      threshold: { deltaGte: 0 },
      zeroDenominator: 'required-unavailable' as const,
    },
    {
      name: 'verification_cost' as const,
      required: false,
      permittedBasis: ['observed' as const],
      minimumCoverage: 0.8,
      formula: 'verification-duration-ms/runs-with-verification-duration' as const,
      direction: 'lower' as const,
      threshold: { variantLteBaseTimes: 1.1 },
      zeroDenominator: 'optional-unavailable' as const,
      accumulation: {
        maximum: Number.MAX_SAFE_INTEGER,
        guard: 'sum>maximum-duration' as const,
        overflow: 'latched-arm-unavailable-all-counts-zero' as const,
        missingDuration: 'not-observed' as const,
      },
    },
  ],
  requiredPairCoverage: 1,
  evidenceBinding: {
    armArtifactAnnotationHashes: 'base-exact-base-and-variant-exact-variant' as const,
    fixtureTaskIdentity: 'exact-manifest-task-family-task-instance-and-input-digest' as const,
    domainPairing: 'exact-manifest-ordered-base-variant-domain-pair' as const,
    pairInclusion: 'both-prescribed-resolved-and-complete' as const,
  },
  runAccounting: {
    fixtureRuns: 'manifest-fixture-count' as const,
    resolvedRuns: 'prescribed-present-snapshot-count' as const,
    completeRuns: 'prescribed-present-complete-snapshot-count' as const,
    incompleteRuns: 'fixtureRuns-completeRuns' as const,
    excludedRuns: 'zero' as const,
  },
  arithmetic: 'ecmascript-binary64-no-rounding-no-tolerance' as const,
  unavailableComparison: 'both-values-and-delta-null' as const,
  overallResultPrecedence: [
    'reject-invalid' as const,
    'failed' as const,
    'incomplete' as const,
    'passed' as const,
  ],
}

export type TemplateOfflinePolicyV1 = DeepReadonly<typeof policyBody>

export const TEMPLATE_OFFLINE_V1_POLICY: TemplateOfflinePolicyV1 = deepFreeze(policyBody)

export const TEMPLATE_OFFLINE_V1_POLICY_BYTES = canonicalGovernanceJson(TEMPLATE_OFFLINE_V1_POLICY)

export const TEMPLATE_OFFLINE_V1_POLICY_DIGEST = sha256Canonical(TEMPLATE_OFFLINE_V1_POLICY)

export const TEMPLATE_OFFLINE_V1_POLICY_REF: DeepReadonly<EvaluatorPolicyRefV1> = deepFreeze({
  policyId: TEMPLATE_OFFLINE_V1_POLICY.policyId,
  policyRevision: TEMPLATE_OFFLINE_V1_POLICY.policyRevision,
  policyDigest: TEMPLATE_OFFLINE_V1_POLICY_DIGEST,
})
