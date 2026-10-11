import { createHash } from 'node:crypto';
import type { Confidence, Finding, FindingType, ProviderId, Severity } from '@contextscope/shared';
import { CACHING_DOCS } from './constants.js';

/** Deterministic finding id: sha256(type + scope), 16 hex chars. Same input → same id (stable dedup). */
export const findingId = (type: FindingType, scope: string): string =>
  createHash('sha256').update(`${type}\u0000${scope}`).digest('hex').slice(0, 16);

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
export const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export interface FindingInput {
  type: FindingType;
  scope: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  description: string;
  evidence: string[];
  recommendation: string;
  tradeoff: string;
  affects: Finding['affects'];
  requestIds: string[];
  segmentIndexes?: number[];
  /** Only with a defensible basis (e.g. duplicated estimated tokens); otherwise omit / null. */
  estimatedTokenReduction?: number | null;
  provider?: ProviderId | null;
  docsUrl?: string | null;
  sessionId?: string | null;
}

export const makeFinding = (f: FindingInput, now: number): Finding => ({
  id: findingId(f.type, f.scope),
  type: f.type,
  title: f.title,
  severity: f.severity,
  confidence: f.confidence,
  description: f.description,
  evidence: f.evidence,
  recommendation: f.recommendation,
  tradeoff: f.tradeoff,
  affects: f.affects,
  requestIds: [...new Set(f.requestIds)],
  segmentIndexes: [...new Set(f.segmentIndexes ?? [])].sort((a, b) => a - b),
  estimatedTokenReduction: f.estimatedTokenReduction ?? null,
  docsUrl: f.docsUrl !== undefined ? f.docsUrl : f.provider ? CACHING_DOCS[f.provider] : null,
  createdAt: new Date(now).toISOString(),
  sessionId: f.sessionId ?? null,
});
