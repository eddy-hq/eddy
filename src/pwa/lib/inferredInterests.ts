// Pure transforms for the "Eddy noticed" band (#159, ADR-0008).
//
// Inferred interests are live-derived proposals from who the user follows.
// They are inert until Kept: Keep promotes a proposal to a declared, ranked
// interest (appended at the next rank); Remove suppresses it. Neither action
// ever interleaves an inferred item into the ranked declared list — inferred
// items have no rank.
//
// These helpers shape the optimistic cache updates so the band and the declared
// list stay consistent without a round-trip. Kept here as plain functions so
// they are unit-testable under the node test environment (no component harness).

export type Expertise = 'beginner' | 'comfortable' | 'deep';

export interface MyInterest {
  interestId: string;
  label: string;
  rank: number;
  expertise: Expertise;
}

export interface InferredInterest {
  interestId: string;
  label: string;
  category: string | null;
  followerCount: number;
  confidence: number;
}

// Whether the "Eddy noticed" band should render. The band is hidden entirely
// when there are no proposals — an empty band is clutter, not a valid state.
export function shouldShowBand(inferred: InferredInterest[] | undefined): boolean {
  return (inferred?.length ?? 0) > 0;
}

// Remove a proposal from the band (optimistic suppress). Returns a new array
// with the matching interest dropped; the declared list is untouched.
export function dropProposal(
  inferred: InferredInterest[],
  interestId: string,
): InferredInterest[] {
  return inferred.filter((p) => p.interestId !== interestId);
}

// Keep promotes a proposal to a declared interest appended at the next rank,
// mirroring the server (keepInferredInterest): the new row sits after the
// current maximum rank with a default 'comfortable' expertise. Returns the
// declared list with the promoted interest appended. A no-op if the interest
// is already declared (defensive against double-Keep) or not in the band.
export function promoteProposal(
  declared: MyInterest[],
  inferred: InferredInterest[],
  interestId: string,
): MyInterest[] {
  if (declared.some((d) => d.interestId === interestId)) return declared;
  const proposal = inferred.find((p) => p.interestId === interestId);
  if (!proposal) return declared;

  const nextRank = declared.reduce((max, d) => Math.max(max, d.rank), 0) + 1;
  return [
    ...declared,
    {
      interestId: proposal.interestId,
      label: proposal.label,
      rank: nextRank,
      expertise: 'comfortable',
    },
  ];
}
