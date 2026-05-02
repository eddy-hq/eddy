import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface ResolveResponse { personId: string }

async function fetchResolve(userId: string, channelId: string, channelName: string): Promise<ResolveResponse> {
  const resp = await fetch('/people/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, channelId, channelName }),
  });
  if (!resp.ok) throw new Error('resolve failed');
  return resp.json() as Promise<ResolveResponse>;
}

// Resolves a YouTube channelId/channelName to a personId via POST /people/resolve.
// Returned function is the call site for any card surface that wants to navigate
// to /person/:personId for a creator regardless of follow state. Cached per
// channelId via the React Query cache so multiple cards from the same channel
// hit the network at most once per session.
export function useResolvePersonId(
  userId: string | null,
): (channelId: string, channelName: string) => Promise<string | null> {
  const queryClient = useQueryClient();
  return useCallback(
    async (channelId, channelName) => {
      if (!userId) return null;
      try {
        const data = await queryClient.fetchQuery({
          queryKey: ['person-resolve', channelId],
          queryFn: () => fetchResolve(userId, channelId, channelName),
          staleTime: 5 * 60_000,
        });
        return data.personId;
      } catch {
        return null;
      }
    },
    [userId, queryClient],
  );
}
