import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

interface FollowedPerson {
  person_id: string;
  display_name: string;
  channel_id: string | null;
}

interface FollowingResponse { following: FollowedPerson[] }

async function fetchFollowing(userId: string): Promise<FollowingResponse> {
  const res = await fetch(`/people/following?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load following');
  return res.json() as Promise<FollowingResponse>;
}

// Returns a lowercased channel-name → personId map for the user's followed
// people. Used by Card and Watch to decide whether the channel name is a
// tap-through. Channel names from /follow originate from yt-dlp, the same
// source feeding `requests.channel`, so case-insensitive equality is reliable.
export function useFollowedByChannelName(userId: string | null): Map<string, string> {
  const { data } = useQuery({
    queryKey: ['person-following', userId],
    queryFn: () => fetchFollowing(userId ?? ''),
    enabled: !!userId,
    staleTime: 60_000,
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    for (const p of data?.following ?? []) {
      if (p.display_name) map.set(p.display_name.toLowerCase(), p.person_id);
    }
    return map;
  }, [data]);
}
