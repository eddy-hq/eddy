import { useQuery } from '@tanstack/react-query';

export interface PersonSummary {
  personId: string;
  displayName: string;
  photoUrl: string | null;
  followedAt: string | null;
}

async function fetchPersonSummary(userId: string, channelId: string): Promise<PersonSummary | null> {
  const res = await fetch(
    `/people/by-channel/${encodeURIComponent(channelId)}?userId=${encodeURIComponent(userId)}`,
  );
  // 404 = no Person row for this channel yet. Not an error: the player row
  // still renders from the channel name with the "Not followed" branch.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('person summary failed');
  return res.json() as Promise<PersonSummary>;
}

// Read-only Person summary (photo + follow date) for the player's Person row.
// Enriches the channel name the card already carries — disabled until both a
// userId and a channelId are present. Cached per channel so re-opening the
// sheet doesn't re-hit the network within the stale window.
export function usePersonSummary(userId: string | null, channelId: string | null) {
  return useQuery({
    queryKey: ['person-summary', channelId, userId],
    queryFn: () => fetchPersonSummary(userId!, channelId!),
    enabled: !!userId && !!channelId,
    staleTime: 60_000,
  });
}
