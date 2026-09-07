import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST,
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BODY,
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BYTES,
  TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_DIGEST,
  TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS,
  TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BODIES,
  TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BYTES,
  TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_DIGESTS,
  TEMPLATE_OFFLINE_V1_POLICY,
  TEMPLATE_OFFLINE_V1_POLICY_BYTES,
  TEMPLATE_OFFLINE_V1_POLICY_DIGEST,
  TEMPLATE_OFFLINE_V1_POLICY_REF,
  assertTemplateOfflineV1CorpusManifest,
  canonicalGovernanceJson,
  sha256Canonical,
} from '../../src/governance/index.js'

const FIXTURE_INPUT_BYTES = [
  '{"fixtureId":"cross-domain-summary","fixtureRevision":"2","input":{"audience":"maintainer","source":["Cache misses increased after deploy.","Rollback restored baseline."],"task":"Write a two-sentence incident summary."},"schemaVersion":1,"taskFamilyRef":"61559f89a7a645e3246f4a47d5c417e500fdbc9ee51e484534bc60e0a9c5201e","taskInstanceRef":"df4a97d32da8a708355e82a5e638c6e1c43fea1a49e7d3a66001e3a96ec83b71"}',
  '{"fixtureId":"same-domain-edit","fixtureRevision":"1","input":{"language":"typescript","request":"Rename the exported function without changing behavior.","source":"export function oldName(value: string): string { return value.trim() }"},"schemaVersion":1,"taskFamilyRef":"4195dd74937d04cee54e196349b7cfc76028a123c706d0b2b2ef2af5b68c5897","taskInstanceRef":"326671e1e3a70c69c4657766036d5cfec13030e1d7c755271d064226b34eb6fc"}',
] as const

const MANIFEST_BYTES = '{"corpusId":"template-offline-v1-corpus","corpusRevision":"1","fixtures":[{"baseDomainRef":"6faf295898b6c961b9f8d9e74002a85f2ff38657dc0b87fdcafed821ecdf4fe1","fixtureId":"cross-domain-summary","fixtureInputDigest":"db247f6fac52248f3f0a20929ce7cb89ec035838a4a2d6e51e7c8de0e9a80a6d","fixtureRevision":"2","pairingKey":"cross-domain-summary","taskFamilyRef":"61559f89a7a645e3246f4a47d5c417e500fdbc9ee51e484534bc60e0a9c5201e","taskInstanceRef":"df4a97d32da8a708355e82a5e638c6e1c43fea1a49e7d3a66001e3a96ec83b71","variantDomainRef":"ec785528ec87ce8c1c8f87277a4bfeac2a39bff87eead6747fb095fae25d8721"},{"baseDomainRef":"6faf295898b6c961b9f8d9e74002a85f2ff38657dc0b87fdcafed821ecdf4fe1","fixtureId":"same-domain-edit","fixtureInputDigest":"ce7c60f5c6b92109f3cc690c355a8f5f56323783c7b70ed1a9569c2d3f03a54c","fixtureRevision":"1","pairingKey":"same-domain-edit","taskFamilyRef":"4195dd74937d04cee54e196349b7cfc76028a123c706d0b2b2ef2af5b68c5897","taskInstanceRef":"326671e1e3a70c69c4657766036d5cfec13030e1d7c755271d064226b34eb6fc","variantDomainRef":"6faf295898b6c961b9f8d9e74002a85f2ff38657dc0b87fdcafed821ecdf4fe1"}],"schemaVersion":1}'

const POLICY_BYTES = '{"arithmetic":"ecmascript-binary64-no-rounding-no-tolerance","corpus":{"corpusId":"template-offline-v1-corpus","corpusManifestDigest":"dca6ef210664d853fc1b2cb3fe88a55a08f4e9a6f33e68d4b2955c05679a33ab","corpusRevision":"1"},"evidenceBinding":{"armArtifactAnnotationHashes":"base-exact-base-and-variant-exact-variant","domainPairing":"exact-manifest-ordered-base-variant-domain-pair","fixtureTaskIdentity":"exact-manifest-task-family-task-instance-and-input-digest","pairInclusion":"both-prescribed-resolved-and-complete"},"metrics":[{"direction":"higher","formula":"successful-known-outcomes/known-outcomes","minimumCoverage":1,"name":"task_success_rate","permittedBasis":["observed"],"required":true,"threshold":{"deltaGte":0},"zeroDenominator":"required-unavailable"},{"direction":"higher","formula":"accepted-true/explicit-acceptance","minimumCoverage":1,"name":"accepted_result_rate","permittedBasis":["observed"],"required":true,"threshold":{"deltaGte":0},"zeroDenominator":"required-unavailable"},{"accumulation":{"guard":"sum>maximum-duration","maximum":9007199254740991,"missingDuration":"not-observed","overflow":"latched-arm-unavailable-all-counts-zero"},"direction":"lower","formula":"verification-duration-ms/runs-with-verification-duration","minimumCoverage":0.8,"name":"verification_cost","permittedBasis":["observed"],"required":false,"threshold":{"variantLteBaseTimes":1.1},"zeroDenominator":"optional-unavailable"}],"overallResultPrecedence":["reject-invalid","failed","incomplete","passed"],"policyId":"template-offline-v1","policyRevision":1,"requiredPairCoverage":1,"runAccounting":{"completeRuns":"prescribed-present-complete-snapshot-count","excludedRuns":"zero","fixtureRuns":"manifest-fixture-count","incompleteRuns":"fixtureRuns-completeRuns","resolvedRuns":"prescribed-present-snapshot-count"},"schemaVersion":1,"unavailableComparison":"both-values-and-delta-null"}'

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child, seen)
}

function rehashManifest(fixtures: unknown[]) {
  const body = {
    schemaVersion: 1 as const,
    corpusId: 'template-offline-v1-corpus' as const,
    corpusRevision: '1' as const,
    fixtures,
  }
  return { ...body, corpusManifestDigest: sha256Canonical(body) }
}

describe('frozen template-offline-v1 corpus', () => {
  it('pins each exact fixture-input preimage byte string and digest', () => {
    expect(TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BYTES).toEqual(FIXTURE_INPUT_BYTES)
    expect(TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_DIGESTS).toEqual([
      'db247f6fac52248f3f0a20929ce7cb89ec035838a4a2d6e51e7c8de0e9a80a6d',
      'ce7c60f5c6b92109f3cc690c355a8f5f56323783c7b70ed1a9569c2d3f03a54c',
    ])
    expect(TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BODIES.map(canonicalGovernanceJson))
      .toEqual(FIXTURE_INPUT_BYTES)
    expect(TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BODIES.map(sha256Canonical))
      .toEqual(TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_DIGESTS)
    expect(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures.map(fixture => fixture.fixtureInputDigest))
      .toEqual(TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_DIGESTS)
  })

  it('pins a non-empty, strictly ordered manifest with mixed fixture revisions and both domain-pair forms', () => {
    expect(TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS).toHaveLength(2)
    expect(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures.map(fixture => [
      fixture.fixtureId,
      fixture.fixtureRevision,
      fixture.pairingKey,
    ])).toEqual([
      ['cross-domain-summary', '2', 'cross-domain-summary'],
      ['same-domain-edit', '1', 'same-domain-edit'],
    ])
    expect(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[0]?.baseDomainRef)
      .not.toBe(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[0]?.variantDomainRef)
    expect(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[1]?.baseDomainRef)
      .toBe(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[1]?.variantDomainRef)
    expect(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BODY.fixtures).toEqual(
      TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures,
    )
    expect(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BYTES).toBe(MANIFEST_BYTES)
    expect(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_DIGEST)
      .toBe('dca6ef210664d853fc1b2cb3fe88a55a08f4e9a6f33e68d4b2955c05679a33ab')
  })

  it('exposes only deeply frozen authoritative objects and arrays', () => {
    for (const value of [
      TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS,
      TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BODIES,
      TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_BYTES,
      TEMPLATE_OFFLINE_V1_FIXTURE_INPUT_DIGESTS,
      TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST_BODY,
      TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST,
    ]) expectDeepFrozen(value)

    const fixture = TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS[0] as unknown as {
      input: { audience: string }
    }
    expect(() => { fixture.input.audience = 'mutated' }).toThrow()
    expect(TEMPLATE_OFFLINE_V1_FIXTURE_DEFINITIONS[0]?.input).toEqual({
      audience: 'maintainer',
      source: ['Cache misses increased after deploy.', 'Rollback restored baseline.'],
      task: 'Write a two-sentence incident summary.',
    })
  })

  it('accepts the authoritative manifest from a detached caller snapshot', () => {
    const caller = JSON.parse(JSON.stringify(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST)) as unknown
    const accepted = assertTemplateOfflineV1CorpusManifest(caller)
    expect(accepted).toEqual(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST)
    expect(accepted).not.toBe(caller)
    expectDeepFrozen(accepted)
  })

  it.each([
    ['substituted', () => {
      const fixtures = structuredClone(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures) as unknown as Array<Record<string, unknown>>
      fixtures[0]!.variantDomainRef = '0'.repeat(64)
      return rehashManifest(fixtures)
    }],
    ['reordered', () => rehashManifest([...TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures].reverse())],
    ['missing', () => rehashManifest(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures.slice(1))],
    ['extra', () => {
      const extra = {
        ...TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[1]!,
        fixtureId: 'third-fixture',
        pairingKey: 'third-fixture',
      }
      return rehashManifest([...TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures, extra])
    }],
    ['duplicate', () => rehashManifest([
      TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[0]!,
      TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures[0]!,
    ])],
    ['stale fixture input', () => {
      const fixtures = structuredClone(TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST.fixtures) as unknown as Array<Record<string, unknown>>
      fixtures[0]!.fixtureInputDigest = '0'.repeat(64)
      return rehashManifest(fixtures)
    }],
  ])('rejects a %s manifest inventory even when its digest is recomputed', (_name, makeManifest) => {
    expect(() => assertTemplateOfflineV1CorpusManifest(makeManifest()))
      .toThrow('governance corpus manifest not authoritative')
  })
})

describe('frozen template-offline-v1 policy', () => {
  it('pins the complete canonical policy bytes, digest, and resolver identity', () => {
    expect(TEMPLATE_OFFLINE_V1_POLICY_BYTES).toBe(POLICY_BYTES)
    expect(TEMPLATE_OFFLINE_V1_POLICY_DIGEST)
      .toBe('434afbf1bda7a12be136528d57ac77c4b12fbbd5a7682ccf994bcea3c453ee60')
    expect(sha256Canonical(TEMPLATE_OFFLINE_V1_POLICY)).toBe(TEMPLATE_OFFLINE_V1_POLICY_DIGEST)
    expect(TEMPLATE_OFFLINE_V1_POLICY_REF).toEqual({
      policyId: 'template-offline-v1',
      policyRevision: 1,
      policyDigest: TEMPLATE_OFFLINE_V1_POLICY_DIGEST,
    })
  })

  it('freezes metric order and every normative comparison, availability, binding, and accounting rule', () => {
    expect(TEMPLATE_OFFLINE_V1_POLICY.metrics.map(metric => metric.name)).toEqual([
      'task_success_rate',
      'accepted_result_rate',
      'verification_cost',
    ])
    expect(TEMPLATE_OFFLINE_V1_POLICY).toMatchObject({
      schemaVersion: 1,
      requiredPairCoverage: 1,
      arithmetic: 'ecmascript-binary64-no-rounding-no-tolerance',
      unavailableComparison: 'both-values-and-delta-null',
      overallResultPrecedence: ['reject-invalid', 'failed', 'incomplete', 'passed'],
      evidenceBinding: {
        armArtifactAnnotationHashes: 'base-exact-base-and-variant-exact-variant',
        fixtureTaskIdentity: 'exact-manifest-task-family-task-instance-and-input-digest',
        domainPairing: 'exact-manifest-ordered-base-variant-domain-pair',
        pairInclusion: 'both-prescribed-resolved-and-complete',
      },
      runAccounting: {
        fixtureRuns: 'manifest-fixture-count',
        resolvedRuns: 'prescribed-present-snapshot-count',
        completeRuns: 'prescribed-present-complete-snapshot-count',
        incompleteRuns: 'fixtureRuns-completeRuns',
        excludedRuns: 'zero',
      },
    })
    expect(TEMPLATE_OFFLINE_V1_POLICY.metrics[2]).toMatchObject({
      required: false,
      permittedBasis: ['observed'],
      minimumCoverage: 0.8,
      formula: 'verification-duration-ms/runs-with-verification-duration',
      direction: 'lower',
      threshold: { variantLteBaseTimes: 1.1 },
      zeroDenominator: 'optional-unavailable',
      accumulation: {
        maximum: Number.MAX_SAFE_INTEGER,
        guard: 'sum>maximum-duration',
        overflow: 'latched-arm-unavailable-all-counts-zero',
        missingDuration: 'not-observed',
      },
    })
    expectDeepFrozen(TEMPLATE_OFFLINE_V1_POLICY)
    expectDeepFrozen(TEMPLATE_OFFLINE_V1_POLICY_REF)
  })
})
