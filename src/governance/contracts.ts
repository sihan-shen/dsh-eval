import type {
  CandidateV1,
  LessonV1,
  ObservationV1,
  RunAnnotationV1,
  RunSealV1,
} from '@ds-plugins/dsh-telemetry/contracts'

export type GovernanceSurfaceV1 = 'template' | 'routing' | 'verification' | 'kernel'

export type ArtifactRefV1 = {
  schemaVersion: 1
  surface: GovernanceSurfaceV1
  version: string
  digest: string
}

export type TemplateArtifactV1 = {
  schemaVersion: 1
  ref: ArtifactRefV1 & { surface: 'template' }
  configHash: string
  promptHash: string
  bindingDigest: string
}

export type CorpusFixtureV1 = {
  fixtureId: string
  fixtureRevision: string
  pairingKey: string
  baseDomainRef: string
  variantDomainRef: string
  taskFamilyRef: string
  taskInstanceRef: string
  fixtureInputDigest: string
}

export type CorpusManifestV1 = {
  schemaVersion: 1
  corpusId: 'template-offline-v1-corpus'
  corpusRevision: '1'
  fixtures: CorpusFixtureV1[]
  corpusManifestDigest: string
}

export type EvaluationRunRefV1 = {
  domainRef: string
  runRef: string
  fixtureId: string
  fixtureRevision: string
  pairingKey: string
}

export type EvaluationArmV1 = {
  artifact: TemplateArtifactV1
  corpusRevision: '1'
  runs: EvaluationRunRefV1[]
  fixtureRuns: number
  resolvedRuns: number
  completeRuns: number
  incompleteRuns: number
  excludedRuns: number
  metrics: ArmMetricObservationV1[]
}

export type ArmMetricObservationV1 = {
  name: string
  value: number | null
  numerator: number
  denominator: number
  observedRuns: number
  eligibleRuns: number
  basis: 'observed' | 'estimated' | 'unavailable'
}

export type EvaluationPairV1 = {
  fixtureId: string
  fixtureRevision: string
  pairingKey: string
  baseRun: EvaluationRunRefV1
  variantRun: EvaluationRunRefV1
}

export type ResolvedRunEvidenceV1 = {
  ref: EvaluationRunRefV1
  observations: ObservationV1[]
  seal: RunSealV1 | null
  annotation: RunAnnotationV1 | null
}

export type OfflineEvidenceResolverInputV1 = {
  schemaVersion: 1
  corpusManifest: CorpusManifestV1
  baseArtifact: TemplateArtifactV1
  variantArtifact: TemplateArtifactV1
  baseRuns: ResolvedRunEvidenceV1[]
  variantRuns: ResolvedRunEvidenceV1[]
}

export type EvaluatorPolicyRefV1 = {
  policyId: 'template-offline-v1'
  policyRevision: 1
  policyDigest: string
}

export type MetricComparisonV1 = {
  name: string
  baseValue: number | null
  variantValue: number | null
  delta: number | null
  result: 'pass' | 'fail' | 'unavailable'
}

export type EvaluationEvidenceV1 = {
  schemaVersion: 1
  policy: EvaluatorPolicyRefV1
  corpusId: string
  corpusRevision: string
  corpusManifestDigest: string
  resolverInput: OfflineEvidenceResolverInputV1
  baseArm: EvaluationArmV1
  variantArm: EvaluationArmV1
  pairs: EvaluationPairV1[]
  comparisons: MetricComparisonV1[]
  result: 'passed' | 'failed' | 'incomplete'
}

export type DomainEvidenceRefV1 = {
  domainRef: string
  runRef: string
  seq: number
}

export type CandidateSupportRunV1 = {
  domainRef: string
  runRef: string
  observations: ObservationV1[]
  seal: RunSealV1 | null
  annotation: RunAnnotationV1 | null
}

export type CandidateSupportV1 = {
  schemaVersion: 1
  lesson: LessonV1
  evidence: DomainEvidenceRefV1[]
  runs: CandidateSupportRunV1[]
}

export type DecisionRecordV1 = {
  decisionId: string
  actorId: string
  occurredAtMs: number
  reasonDigest: string
}

export type GovernanceProposalV1 = {
  schemaVersion: 1
  proposalId: string
  candidate: CandidateV1
  candidateSupport: CandidateSupportV1
  bundleVersion: string
  policyGeneration: string
  surface: 'template'
  base: TemplateArtifactV1
  variant: TemplateArtifactV1
  evaluation: EvaluationEvidenceV1
  status: 'proposed' | 'approved' | 'rejected' | 'promoted' | 'rolled-back'
  approval: DecisionRecordV1 | null
  rejection: DecisionRecordV1 | null
  promotion: DecisionRecordV1 | null
  rollback: DecisionRecordV1 | null
  rollbackTarget: ArtifactRefV1 | null
}

export type GovernanceEntryV1 = {
  schemaVersion: 1
  sequence: number
  entryId: string
  predecessorDigest: string | null
  transition: 'propose' | 'approve' | 'reject' | 'promote' | 'rollback'
  decision: DecisionRecordV1 | null
  proposal: GovernanceProposalV1
}

export type GovernanceLedgerV1 = {
  schemaVersion: 1
  initialActive: { template: TemplateArtifactV1 }
  entries: GovernanceEntryV1[]
  headDigest: string | null
}
