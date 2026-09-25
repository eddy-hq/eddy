import {
  evaluateCandidate,
  type GuardVerdict,
  type StoredVideoMetadata,
} from '../guard/index';
import { statusForGuardVerdict, type GuardedCandidateStatus } from './util';

export interface GuardableCandidate {
  candidate_id: string;
  url: string;
  title: string | null;
  channel: string | null;
  external_id: string | null;
}

export interface CandidateGuardOutcome {
  verdict: GuardVerdict;
  nextStatus: GuardedCandidateStatus;
  ageRestricted: boolean;
}

// Guard one kid candidate with whatever Data API metadata is stored for it.
// The single mapping from a candidate_pool row onto evaluateCandidate's
// arguments: discovery's recheck and the parked re-run both call this, so the
// two can't feed the guard different inputs. Writes a guard_eval row (via the
// guard) but never touches candidate_pool — the caller decides whether to
// apply `nextStatus`.
export async function guardCandidate(
  c: GuardableCandidate,
  userId: string,
  ageBand: string,
  metadata: Map<string, StoredVideoMetadata>,
): Promise<CandidateGuardOutcome> {
  const meta = c.external_id ? metadata.get(c.external_id) : undefined;
  const ageRestricted = meta?.ageRestricted ?? false;
  const verdict = await evaluateCandidate({
    candidateId: c.candidate_id,
    userId,
    url: c.url,
    title: c.title ?? '',
    channel: c.channel,
    ageBand,
    description: meta?.description ?? null,
    tags: meta?.tags ?? null,
    categoryId: meta?.categoryId ?? null,
    madeForKids: meta?.madeForKids ?? null,
    ageRestricted,
  });
  return { verdict, nextStatus: statusForGuardVerdict(verdict.verdict), ageRestricted };
}
