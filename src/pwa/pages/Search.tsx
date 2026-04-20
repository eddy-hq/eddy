import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomNav } from '../components/BottomNav';
import { Card } from '../components/Card';
import type { CardData } from '../components/Card';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchResult {
  request_id: string;
  url: string;
  youtube_id: string | null;
  title: string | null;
  channel: string | null;
  status: string;
  file_state: string;
  rejection_reason: string | null;
  nginx_url: string | null;
  thumbnail_url: string | null;
  duration_secs: number | null;
  requested_at: string;
  added_at: string;
  watched_at: string | null;
  saved_at: string | null;
  source: string;
}

interface ChannelResult {
  channelId: string;
  channelName: string;
  channelUrl: string;
  following: boolean;
}

interface ChannelSearchResponse {
  channels: ChannelResult[];
  searchError?: boolean;
}

type Tab = 'all' | 'library' | 'channels';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'library',  label: 'Library' },
  { id: 'channels', label: 'Channels' },
];

// ── Debounce hook ─────────────────────────────────────────────────────────────

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function searchLibrary(q: string, userId: string): Promise<SearchResult[]> {
  const resp = await fetch(`/search?q=${encodeURIComponent(q)}&userId=${encodeURIComponent(userId)}`);
  if (!resp.ok) throw new Error('Search failed');
  return ((await resp.json() as { results: SearchResult[] }).results);
}

async function searchChannels(q: string, userId: string): Promise<ChannelSearchResponse> {
  const resp = await fetch(`/people/search?q=${encodeURIComponent(q)}&userId=${encodeURIComponent(userId)}`);
  if (!resp.ok) throw new Error('Channel search failed');
  return resp.json() as Promise<ChannelSearchResponse>;
}

async function followChannel(userId: string, channel: ChannelResult): Promise<void> {
  const resp = await fetch('/people/follow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, channelId: channel.channelId, channelName: channel.channelName }),
  });
  if (!resp.ok) throw new Error('Follow failed');
}

async function unfollowChannel(userId: string, channelId: string): Promise<void> {
  const resp = await fetch(`/people/follow/${encodeURIComponent(channelId)}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
  if (!resp.ok) throw new Error('Unfollow failed');
}

function toCardData(r: SearchResult): CardData {
  return {
    requestId: r.request_id,
    url: r.url,
    youtubeId: r.youtube_id,
    title: r.title,
    channel: r.channel,
    status: r.status,
    fileState: r.file_state,
    rejectionReason: r.rejection_reason,
    nginxUrl: r.nginx_url,
    thumbnailUrl: r.thumbnail_url,
    durationSecs: r.duration_secs,
    requestedAt: r.requested_at,
    addedAt: r.added_at,
    watchedAt: r.watched_at,
    savedAt: r.saved_at,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Search() {
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? params.get('user') ?? '';
  const queryClient = useQueryClient();

  const [inputValue, setInputValue] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  const libraryQuery = useDebounce(inputValue, 250);
  const channelQuery = useDebounce(inputValue, 800);

  const libraryResults = useQuery({
    queryKey: ['search-library', libraryQuery, userId],
    queryFn: () => searchLibrary(libraryQuery, userId),
    enabled: libraryQuery.length >= 2 && !!userId,
    staleTime: 30_000,
  });

  const channelResults = useQuery({
    queryKey: ['search-channels', channelQuery, userId],
    queryFn: () => searchChannels(channelQuery, userId),
    enabled: channelQuery.length >= 2 && !!userId,
    staleTime: 60_000,
  });

  const channels = channelResults.data?.channels ?? [];
  const channelSearchError = channelResults.data?.searchError ?? false;

  const followMutation = useMutation({
    mutationFn: (channel: ChannelResult) => followChannel(userId, channel),
    onSuccess: (_data, channel) => {
      queryClient.setQueryData<ChannelSearchResponse>(
        ['search-channels', channelQuery, userId],
        (old) => old ? { ...old, channels: old.channels.map((c) => c.channelId === channel.channelId ? { ...c, following: true } : c) } : old
      );
      void queryClient.invalidateQueries({ queryKey: ['people-following', userId] });
    },
  });

  const unfollowMutation = useMutation({
    mutationFn: (channelId: string) => unfollowChannel(userId, channelId),
    onSuccess: (_data, channelId) => {
      queryClient.setQueryData<ChannelSearchResponse>(
        ['search-channels', channelQuery, userId],
        (old) => old ? { ...old, channels: old.channels.map((c) => c.channelId === channelId ? { ...c, following: false } : c) } : old
      );
      void queryClient.invalidateQueries({ queryKey: ['people-following', userId] });
    },
  });

  const hasInput = inputValue.length >= 2;
  const videos = libraryResults.data ?? [];

  const libraryPending = inputValue !== libraryQuery && inputValue.length >= 2;
  const channelPending = inputValue !== channelQuery && inputValue.length >= 2;

  const showLibrary = hasInput && (activeTab === 'all' || activeTab === 'library');
  const showChannels = hasInput && (activeTab === 'all' || activeTab === 'channels');

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>

      {/* ── Sticky header: search bar + filter tabs ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'var(--bg-primary)',
        paddingTop: 'env(safe-area-inset-top)',
      }}>
        {/* Search row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px 8px',
        }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{
              position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)',
              pointerEvents: 'none', color: 'var(--text-tertiary)',
              display: 'flex', alignItems: 'center',
            }}>
              <svg width="15" height="15" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9.5" cy="9.5" r="6.5"/>
                <line x1="14.5" y1="14.5" x2="20" y2="20"/>
              </svg>
            </span>
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Search videos, channels…"
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
              style={{
                width: '100%',
                padding: '9px 12px 9px 34px',
                borderRadius: 12,
                border: 'none',
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontSize: 15,
                outline: 'none',
                boxSizing: 'border-box',
                WebkitAppearance: 'none',
              }}
            />
          </div>

          {/* Clear button — outside the pill, only when there's input */}
          {inputValue && (
            <button
              onClick={() => { setInputValue(''); inputRef.current?.focus(); }}
              style={{
                flexShrink: 0,
                background: 'none', border: 'none',
                padding: '6px 2px',
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
                fontSize: 14, fontWeight: 500,
                lineHeight: 1,
              }}
              aria-label="Clear search"
            >
              Cancel
            </button>
          )}
        </div>

        {/* Filter tabs — only visible when there's input */}
        {hasInput && (
          <div style={{
            display: 'flex', gap: 6,
            padding: '0 16px 10px',
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flexShrink: 0,
                  padding: '5px 14px',
                  borderRadius: 20,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: activeTab === tab.id ? 600 : 500,
                  background: activeTab === tab.id ? 'var(--accent)' : 'var(--bg-elevated)',
                  color: activeTab === tab.id ? '#fff' : 'var(--text-secondary)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div style={{ height: 1, background: 'var(--border-subtle)' }} />
      </div>

      <main style={{ paddingBottom: 100 }}>
        {!userId && <Empty text="No user selected." />}

        {userId && !hasInput && <Empty text="Type to search videos and channels." />}

        {userId && hasInput && (
          <>
            {showLibrary && (
              <Section
                label="Library"
                count={videos.length}
                loading={libraryPending || libraryResults.isLoading}
                error={libraryResults.isError}
              >
                {videos.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px' }}>
                    {videos.map((r) => (
                      <Card key={r.request_id} data={toCardData(r)} userId={userId} />
                    ))}
                  </div>
                ) : libraryResults.isFetched && !libraryResults.isFetching ? (
                  <p style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '0 16px 4px' }}>
                    Nothing in your library matches.
                  </p>
                ) : null}
              </Section>
            )}

            {showChannels && (
              <Section
                label="Channels"
                count={channels.length}
                loading={channelPending || channelResults.isLoading}
                error={channelResults.isError || channelSearchError}
              >
                {channels.length > 0 ? (
                  <div style={{ padding: '0 16px' }}>
                    {channels.map((ch) => (
                      <ChannelRow
                        key={ch.channelId}
                        channel={ch}
                        onFollow={() => followMutation.mutate(ch)}
                        onUnfollow={() => unfollowMutation.mutate(ch.channelId)}
                      />
                    ))}
                  </div>
                ) : channelResults.isFetched && !channelResults.isFetching && !channelSearchError ? (
                  <p style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '0 16px 4px' }}>
                    No channels found.
                  </p>
                ) : null}
              </Section>
            )}
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function Section({
  label,
  count,
  loading,
  error,
  children,
}: {
  label: string;
  count: number;
  loading: boolean;
  error: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ paddingTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 10px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {label}
        </span>
        {loading && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>…</span>
        )}
        {!loading && count > 0 && (
          <span style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
            background: 'var(--bg-elevated)', borderRadius: 8, padding: '1px 6px',
          }}>
            {count}
          </span>
        )}
        {error && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>unavailable</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Channel row ───────────────────────────────────────────────────────────────

function ChannelRow({
  channel,
  onFollow,
  onUnfollow,
}: {
  channel: ChannelResult;
  onFollow: () => void;
  onUnfollow: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 0',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%',
        background: 'var(--bg-elevated)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)',
      }}>
        {channel.channelName.charAt(0).toUpperCase()}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {channel.channelName}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {channel.channelUrl.replace('https://www.youtube.com/', 'youtube.com/')}
        </div>
      </div>

      <button
        onClick={channel.following ? onUnfollow : onFollow}
        style={{
          padding: '6px 14px', borderRadius: 20, border: 'none',
          fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
          background: channel.following ? 'var(--bg-elevated)' : 'var(--accent)',
          color: channel.following ? 'var(--text-secondary)' : '#fff',
        }}
      >
        {channel.following ? 'Following' : 'Follow'}
      </button>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function Empty({ text }: { text: string }) {
  return (
    <p style={{ color: 'var(--text-tertiary)', fontSize: 14, textAlign: 'center', marginTop: 60 }}>
      {text}
    </p>
  );
}
