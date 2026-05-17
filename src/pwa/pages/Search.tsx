import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomNav } from '../components/BottomNav';
import { Card } from '../components/Card';
import type { CardData } from '../components/Card';
import { useRestorePolling } from '../hooks/useRestorePolling';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LibraryResult {
  request_id: string;
  url: string;
  youtube_id: string | null;
  youtube_channel_id: string | null;
  title: string | null;
  channel: string | null;
  status: string;
  file_state: string;
  rejection_reason: string | null;
  nginx_url: string | null;
  thumbnail_url: string | null;
  duration_secs: number | null;
  why_text: string | null;
  requested_at: string;
  added_at: string;
  watched_at: string | null;
  saved_at: string | null;
  source: string;
}

interface VideoResult {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  durationSecs: number | null;
  thumbnailUrl: string | null;
  url: string;
  inLibrary: boolean;
}

interface VideoSearchResponse {
  results: VideoResult[];
  searchError?: boolean;
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

type Tab = 'all' | 'channels' | 'videos' | 'library';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'channels', label: 'Channels' },
  { id: 'videos',   label: 'Videos' },
  { id: 'library',  label: 'Library' },
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function searchLibrary(q: string, userId: string): Promise<LibraryResult[]> {
  const resp = await fetch(`/search?q=${encodeURIComponent(q)}&userId=${encodeURIComponent(userId)}`);
  if (!resp.ok) throw new Error('Search failed');
  return ((await resp.json() as { results: LibraryResult[] }).results);
}

async function searchVideos(q: string, userId: string): Promise<VideoSearchResponse> {
  const resp = await fetch(`/search/videos?q=${encodeURIComponent(q)}&userId=${encodeURIComponent(userId)}`);
  if (!resp.ok) throw new Error('Video search failed');
  return resp.json() as Promise<VideoSearchResponse>;
}

async function searchChannels(q: string, userId: string): Promise<ChannelSearchResponse> {
  const resp = await fetch(`/people/search?q=${encodeURIComponent(q)}&userId=${encodeURIComponent(userId)}`);
  if (!resp.ok) throw new Error('Channel search failed');
  return resp.json() as Promise<ChannelSearchResponse>;
}

async function requestVideo(userId: string, url: string): Promise<void> {
  const resp = await fetch('/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, url }),
  });
  if (!resp.ok) throw new Error('Request failed');
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

async function resolvePerson(userId: string, channelId: string, channelName: string): Promise<string> {
  const resp = await fetch('/people/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, channelId, channelName }),
  });
  if (!resp.ok) throw new Error('Resolve failed');
  const body = await resp.json() as { personId: string };
  return body.personId;
}

function toCardData(r: LibraryResult): CardData {
  return {
    requestId: r.request_id,
    youtubeId: r.youtube_id,
    youtubeChannelId: r.youtube_channel_id,
    title: r.title ?? r.url,
    channel: r.channel,
    status: r.status,
    fileState: r.file_state,
    rejectionReason: r.rejection_reason,
    nginxUrl: r.nginx_url,
    youtubeWatchUrl: r.url,
    thumbnailUrl: r.thumbnail_url,
    durationSecs: r.duration_secs,
    whyText: r.why_text,
    requestedAt: r.requested_at,
    watchedAt: r.watched_at,
    savedAt: r.saved_at,
    source: r.source,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Search() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const userId = params.get('userId') ?? params.get('user') ?? '';
  const queryClient = useQueryClient();
  useRestorePolling();

  const [inputValue, setInputValue] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  // Library: fast local FTS. Channels + Videos: hit yt-dlp, longer debounce.
  const libraryQuery  = useDebounce(inputValue, 250);
  const externalQuery = useDebounce(inputValue, 800);

  const libraryResults = useQuery({
    queryKey: ['search-library', libraryQuery, userId],
    queryFn: () => searchLibrary(libraryQuery, userId),
    enabled: libraryQuery.length >= 2 && !!userId,
    staleTime: 30_000,
  });

  const videoResults = useQuery({
    queryKey: ['search-videos', externalQuery, userId],
    queryFn: () => searchVideos(externalQuery, userId),
    enabled: externalQuery.length >= 2 && !!userId,
    staleTime: 60_000,
  });

  const channelResults = useQuery({
    queryKey: ['search-channels', externalQuery, userId],
    queryFn: () => searchChannels(externalQuery, userId),
    enabled: externalQuery.length >= 2 && !!userId,
    staleTime: 60_000,
  });

  const videos   = videoResults.data?.results ?? [];
  const channels = channelResults.data?.channels ?? [];
  const library  = libraryResults.data ?? [];

  const requestMutation = useMutation({
    mutationFn: (url: string) => requestVideo(userId, url),
    onSuccess: (_data, url) => {
      // Mark video as in-library optimistically
      queryClient.setQueryData<VideoSearchResponse>(
        ['search-videos', externalQuery, userId],
        (old) => old ? { ...old, results: old.results.map((v) => v.url === url ? { ...v, inLibrary: true } : v) } : old
      );
    },
  });

  const followMutation = useMutation({
    mutationFn: (channel: ChannelResult) => followChannel(userId, channel),
    onSuccess: (_data, channel) => {
      queryClient.setQueryData<ChannelSearchResponse>(
        ['search-channels', externalQuery, userId],
        (old) => old ? { ...old, channels: old.channels.map((c) => c.channelId === channel.channelId ? { ...c, following: true } : c) } : old
      );
      void queryClient.invalidateQueries({ queryKey: ['person-following', userId] });
    },
  });

  const unfollowMutation = useMutation({
    mutationFn: (channelId: string) => unfollowChannel(userId, channelId),
    onSuccess: (_data, channelId) => {
      queryClient.setQueryData<ChannelSearchResponse>(
        ['search-channels', externalQuery, userId],
        (old) => old ? { ...old, channels: old.channels.map((c) => c.channelId === channelId ? { ...c, following: false } : c) } : old
      );
      void queryClient.invalidateQueries({ queryKey: ['person-following', userId] });
    },
  });

  const hasInput      = inputValue.length >= 2;
  const externalPending = inputValue !== externalQuery && inputValue.length >= 2;
  const libraryPending  = inputValue !== libraryQuery  && inputValue.length >= 2;

  const showChannels = hasInput && (activeTab === 'all' || activeTab === 'channels');
  const showVideos   = hasInput && (activeTab === 'all' || activeTab === 'videos');
  const showLibrary  = hasInput && (activeTab === 'all' || activeTab === 'library');

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>

      {/* ── Sticky header ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'var(--bg-primary)',
        paddingTop: 'env(safe-area-inset-top)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{
              position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)',
              pointerEvents: 'none', color: 'var(--text-tertiary)',
              display: 'flex', alignItems: 'center',
            }}>
              <svg width="15" height="15" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9.5" cy="9.5" r="6.5"/><line x1="14.5" y1="14.5" x2="20" y2="20"/>
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
                width: '100%', padding: '9px 12px 9px 34px',
                borderRadius: 12, border: 'none',
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontSize: 15, outline: 'none',
                boxSizing: 'border-box', WebkitAppearance: 'none',
              }}
            />
          </div>
          {inputValue && (
            <button
              onClick={() => { setInputValue(''); inputRef.current?.focus(); }}
              style={{
                flexShrink: 0, background: 'none', border: 'none',
                padding: '6px 2px', cursor: 'pointer',
                color: 'var(--text-tertiary)', fontSize: 14, fontWeight: 500, lineHeight: 1,
              }}
              aria-label="Clear search"
            >
              Cancel
            </button>
          )}
        </div>

        {hasInput && (
          <div style={{
            display: 'flex', gap: 6, padding: '0 16px 10px',
            overflowX: 'auto', scrollbarWidth: 'none',
          }}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flexShrink: 0, padding: '5px 14px', borderRadius: 20, border: 'none',
                  cursor: 'pointer', fontSize: 13,
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
            {showChannels && (
              <Section
                label="Channels"
                count={channels.length}
                loading={externalPending || channelResults.isLoading}
                error={channelResults.isError || (channelResults.data?.searchError ?? false)}
              >
                {channels.length > 0 ? (
                  <div style={{ padding: '0 16px' }}>
                    {channels.map((ch) => (
                      <ChannelRow
                        key={ch.channelId}
                        channel={ch}
                        onFollow={() => followMutation.mutate(ch)}
                        onUnfollow={() => unfollowMutation.mutate(ch.channelId)}
                        onOpen={async () => {
                          const personId = await resolvePerson(userId, ch.channelId, ch.channelName);
                          navigate(`/person/${personId}?userId=${encodeURIComponent(userId)}`);
                        }}
                      />
                    ))}
                  </div>
                ) : channelResults.isFetched && !channelResults.isFetching && !(channelResults.data?.searchError) ? (
                  <EmptySection text="No channels found." />
                ) : null}
              </Section>
            )}

            {showVideos && (
              <Section
                label="Videos"
                count={videos.length}
                loading={externalPending || videoResults.isLoading}
                error={videoResults.isError || (videoResults.data?.searchError ?? false)}
              >
                {videos.length > 0 ? (
                  <div style={{ padding: '0 16px' }}>
                    {videos.map((v) => (
                      <VideoRow
                        key={v.videoId}
                        video={v}
                        onRequest={() => requestMutation.mutate(v.url)}
                        requesting={requestMutation.isPending && requestMutation.variables === v.url}
                      />
                    ))}
                  </div>
                ) : videoResults.isFetched && !videoResults.isFetching && !(videoResults.data?.searchError) ? (
                  <EmptySection text="No videos found." />
                ) : null}
              </Section>
            )}

            {showLibrary && (
              <Section
                label="Library"
                count={library.length}
                loading={libraryPending || libraryResults.isLoading}
                error={libraryResults.isError}
              >
                {library.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px' }}>
                    {library.map((r) => (
                      <Card
                        key={r.request_id}
                        data={toCardData(r)}
                        userId={userId}
                        onSelect={(c) => navigate(`/watch/${c.requestId}?from=search`)}
                      />
                    ))}
                  </div>
                ) : libraryResults.isFetched && !libraryResults.isFetching ? (
                  <EmptySection text="Nothing in your library matches." />
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

// ── Section ───────────────────────────────────────────────────────────────────

function Section({ label, count, loading, error, children }: {
  label: string; count: number; loading: boolean; error: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ paddingTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 10px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {label}
        </span>
        {loading && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>…</span>}
        {!loading && count > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', background: 'var(--bg-elevated)', borderRadius: 8, padding: '1px 6px' }}>
            {count}
          </span>
        )}
        {error && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>unavailable</span>}
      </div>
      {children}
    </div>
  );
}

// ── Video row ─────────────────────────────────────────────────────────────────

function VideoRow({ video, onRequest, requesting }: {
  video: VideoResult; onRequest: () => void; requesting: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 0', borderBottom: '1px solid var(--border-subtle)',
    }}>
      {video.thumbnailUrl ? (
        <img
          src={video.thumbnailUrl}
          alt=""
          style={{ width: 80, height: 45, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: 'var(--bg-elevated)' }}
        />
      ) : (
        <div style={{ width: 80, height: 45, borderRadius: 6, background: 'var(--bg-elevated)', flexShrink: 0 }} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {video.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{video.channel}</span>
          {video.durationSecs != null && (
            <span style={{ flexShrink: 0 }}>· {formatDuration(video.durationSecs)}</span>
          )}
        </div>
      </div>

      <button
        onClick={onRequest}
        disabled={video.inLibrary || requesting}
        style={{
          flexShrink: 0, padding: '6px 14px', borderRadius: 20, border: 'none',
          fontSize: 13, fontWeight: 600, cursor: video.inLibrary ? 'default' : 'pointer',
          background: video.inLibrary ? 'var(--bg-elevated)' : 'var(--accent)',
          color: video.inLibrary ? 'var(--text-tertiary)' : '#fff',
          opacity: requesting ? 0.6 : 1,
        }}
      >
        {video.inLibrary ? 'In library' : requesting ? '…' : 'Get'}
      </button>
    </div>
  );
}

// ── Channel row ───────────────────────────────────────────────────────────────

function ChannelRow({ channel, onFollow, onUnfollow, onOpen }: {
  channel: ChannelResult;
  onFollow: () => void;
  onUnfollow: () => void;
  onOpen: () => Promise<void>;
}) {
  const [opening, setOpening] = useState(false);

  async function handleOpen() {
    if (opening) return;
    setOpening(true);
    try {
      await onOpen();
    } finally {
      setOpening(false);
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', gap: 12,
      padding: '0', borderBottom: '1px solid var(--border-subtle)',
    }}>
      <button
        onClick={() => { void handleOpen(); }}
        disabled={opening}
        aria-label={`Open ${channel.channelName}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          flex: 1, minWidth: 0,
          padding: '10px 0',
          background: 'none', border: 'none',
          cursor: opening ? 'default' : 'pointer',
          textAlign: 'left', fontFamily: 'inherit',
          color: 'var(--text-primary)',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
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
      </button>
      <button
        onClick={channel.following ? onUnfollow : onFollow}
        style={{
          alignSelf: 'center',
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

// ── Empty states ──────────────────────────────────────────────────────────────

function Empty({ text }: { text: string }) {
  return <p style={{ color: 'var(--text-tertiary)', fontSize: 14, textAlign: 'center', marginTop: 60 }}>{text}</p>;
}

function EmptySection({ text }: { text: string }) {
  return <p style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '0 16px 4px' }}>{text}</p>;
}
