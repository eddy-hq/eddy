import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';
import { Card, type CardData } from '../components/Card';
import { VideoDetailSheet } from '../components/VideoDetailSheet';
import { useVideoSheet } from '../hooks/useVideoSheet';

interface PersonViewItem {
  request_id: string;
  title: string | null;
  channel: string | null;
  youtube_id: string | null;
  url: string;
  status: string;
  file_state: string;
  nginx_url: string | null;
  thumbnail_url: string | null;
  duration_secs: number | null;
  rejection_reason: string | null;
  requested_at: string;
  added_at: string;
  watched_at: string | null;
  saved_at: string | null;
}

type SupportKind = 'patreon' | 'substack' | 'bandcamp' | 'kofi' | 'bookshop' | 'merch' | 'other';

interface PersonViewSupport {
  kind: SupportKind;
  label: string;
  url: string;
}

interface PersonViewResponse {
  person: {
    personId: string;
    displayName: string;
    personType: string | null;
    photoUrl: string | null;
    bio: string | null;
    channelId: string | null;
  };
  items: PersonViewItem[];
  support: PersonViewSupport[];
  followedAt: string | null;
  userRole: string;
}

const KID_VISIBLE_KINDS = new Set<SupportKind>([
  'patreon', 'substack', 'bandcamp', 'kofi', 'bookshop', 'merch',
]);

async function fetchPersonView(personId: string, userId: string): Promise<PersonViewResponse> {
  const res = await fetch(`/people/${encodeURIComponent(personId)}?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load person');
  return res.json() as Promise<PersonViewResponse>;
}

async function unfollowPerson(channelId: string, userId: string): Promise<void> {
  const res = await fetch(
    `/people/follow/${encodeURIComponent(channelId)}?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error('Unfollow failed');
}

function toCardData(row: PersonViewItem): CardData {
  return {
    requestId: row.request_id,
    title: row.title ?? row.url,
    channel: row.channel,
    youtubeId: row.youtube_id,
    status: row.status,
    fileState: row.file_state,
    nginxUrl: row.nginx_url,
    thumbnailUrl: row.thumbnail_url,
    durationSecs: row.duration_secs,
    requestedAt: row.requested_at,
    rejectionReason: row.rejection_reason,
    watchedAt: row.watched_at,
    savedAt: row.saved_at,
  };
}

function monthYear(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

export function Person() {
  const { personId } = useParams<{ personId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const userId = params.get('userId') ?? params.get('user') ?? '';
  const userParam = params.get('userId') ? `userId=${params.get('userId')}` : params.get('user') ? `user=${params.get('user')}` : '';

  const { selectedCard, selectedSource, onSelect, onClose } = useVideoSheet();
  const [showConfirm, setShowConfirm] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['person-view', personId, userId],
    queryFn: () => fetchPersonView(personId ?? '', userId),
    enabled: !!personId && !!userId,
  });

  const unfollowMutation = useMutation({
    mutationFn: () => {
      if (!data?.person.channelId) return Promise.reject(new Error('no channel'));
      return unfollowPerson(data.person.channelId, userId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['person-following', userId] });
      navigate(userParam ? `/profile?${userParam}` : '/profile');
    },
  });

  if (!userId) return <Empty text="No user selected." />;
  if (!personId) return <Empty text="No person selected." />;
  if (isLoading) return <Empty text="Loading…" />;
  if (isError || !data) return <Empty text="Could not load." />;

  const isKid = data.userRole === 'kid';
  const visibleSupport = isKid
    ? data.support.filter((s) => KID_VISIBLE_KINDS.has(s.kind))
    : data.support;

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px 10px' }}>
          <button
            onClick={() => navigate(-1)}
            aria-label="Back"
            style={{
              width: 40, height: 40, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
        </div>
      </div>

      <main style={{ paddingBottom: 140 }}>
        <header style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '24px 22px 18px',
          textAlign: 'center',
        }}>
          <PersonPhoto photoUrl={data.person.photoUrl} alt={data.person.displayName} />
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em',
            color: 'var(--text-primary)',
            margin: '14px 0 0',
          }}>
            {data.person.displayName}
          </h1>
          {data.person.bio && (
            <p style={{
              margin: '8px 0 0',
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: 15, lineHeight: 1.45,
              color: 'var(--text-secondary)',
              maxWidth: 360,
            }}>
              {data.person.bio}
            </p>
          )}
          {data.followedAt && (
            <p style={{
              margin: '12px 0 0',
              fontSize: 12, color: 'var(--text-tertiary)',
              letterSpacing: '0.02em',
            }}>
              Following since {monthYear(data.followedAt)}
            </p>
          )}
        </header>

        {data.items.length > 0 && (
          <section style={{ padding: '0 16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <AnimatePresence mode="popLayout">
                {data.items.map((row) => (
                  <Card
                    key={row.request_id}
                    data={toCardData(row)}
                    userId={userId}
                    onSelect={(c) => onSelect(c, 'person')}
                    isSelected={selectedCard?.requestId === row.request_id}
                  />
                ))}
              </AnimatePresence>
            </div>
          </section>
        )}

        {visibleSupport.length > 0 && (
          <section style={{ padding: '32px 22px 0' }}>
            <h2 style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 14, fontWeight: 500, letterSpacing: '0.005em',
              color: 'var(--text-secondary)',
              margin: '0 0 10px',
            }}>
              Support
            </h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {visibleSupport.map((s) => (
                <SupportItem key={s.url} item={s} asLink={!isKid} />
              ))}
            </div>
          </section>
        )}

        <section style={{ padding: '32px 22px 0' }}>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={!data.person.channelId || unfollowMutation.isPending}
            style={{
              width: '100%', padding: '14px',
              background: 'var(--bg-surface)',
              border: '1.5px solid var(--border-subtle)',
              borderRadius: 12,
              color: 'var(--text-secondary)',
              fontFamily: 'inherit',
              fontSize: 14, fontWeight: 600,
              cursor: (data.person.channelId && !unfollowMutation.isPending) ? 'pointer' : 'default',
              opacity: data.person.channelId ? 1 : 0.5,
            }}
          >
            Unfollow
          </button>
        </section>
      </main>

      <AnimatePresence>
        {showConfirm && (
          <UnfollowConfirm
            personName={data.person.displayName}
            pending={unfollowMutation.isPending}
            onCancel={() => setShowConfirm(false)}
            onConfirm={() => unfollowMutation.mutate()}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectedCard && (
          <VideoDetailSheet
            key={selectedCard.requestId}
            card={selectedCard}
            userId={userId}
            source={selectedSource ?? 'person'}
            onClose={onClose}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function PersonPhoto({ photoUrl, alt }: { photoUrl: string | null; alt: string }) {
  const [errored, setErrored] = useState(false);
  const showImage = photoUrl && !errored;
  return (
    <div style={{
      width: 96, height: 96, borderRadius: '50%',
      overflow: 'hidden',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-subtle)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      {showImage ? (
        <img
          src={photoUrl}
          alt={alt}
          onError={() => setErrored(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Silhouette />
      )}
    </div>
  );
}

function Silhouette() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="9" r="3.6" fill="var(--text-tertiary)" />
      <path d="M4.5 20.5c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function SupportItem({ item, asLink }: { item: PersonViewSupport; asLink: boolean }) {
  const baseStyle: React.CSSProperties = {
    padding: '8px 14px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 999,
    fontSize: 13, fontWeight: 500,
    color: 'var(--text-secondary)',
    fontFamily: 'inherit',
    textDecoration: 'none',
    display: 'inline-flex', alignItems: 'center',
  };
  if (asLink) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        style={{ ...baseStyle, color: 'var(--accent)', cursor: 'pointer' }}
      >
        {item.label}
      </a>
    );
  }
  return <span style={baseStyle}>{item.label}</span>;
}

function UnfollowConfirm({
  personName, pending, onCancel, onConfirm,
}: {
  personName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !pending) onCancel(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, pending]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={() => { if (!pending) onCancel(); }}
        aria-hidden
        style={{ position: 'fixed', inset: 0, zIndex: 49, background: 'rgba(0,0,0,0.42)' }}
      />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ duration: 0.28, ease: [0.33, 1, 0.68, 1] }}
        role="dialog"
        aria-modal="true"
        aria-label={`Unfollow ${personName}`}
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
          background: 'var(--bg-primary)',
          borderTopLeftRadius: 18, borderTopRightRadius: 18,
          padding: '10px 22px 32px',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div style={{
          width: 40, height: 4, borderRadius: 2,
          background: 'var(--border-subtle)',
          margin: '0 auto 18px',
        }} />
        <h2 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 20, fontWeight: 500, letterSpacing: '-0.005em',
          color: 'var(--text-primary)',
          margin: '0 0 8px',
        }}>
          Stop following {personName}?
        </h2>
        <p style={{
          margin: '0 0 22px',
          fontSize: 14, lineHeight: 1.5,
          color: 'var(--text-secondary)',
        }}>
          You'll keep the videos you have. New uploads won't arrive.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            disabled={pending}
            style={{
              flex: 1, padding: '12px 0',
              background: 'var(--bg-surface)',
              border: '1.5px solid var(--border-subtle)',
              borderRadius: 12,
              color: 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
              cursor: pending ? 'default' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            style={{
              flex: 1, padding: '12px 0',
              background: 'var(--dismiss)',
              border: 'none',
              borderRadius: 12,
              color: '#fff',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
              cursor: pending ? 'default' : 'pointer',
              opacity: pending ? 0.6 : 1,
            }}
          >
            {pending ? 'Unfollowing…' : 'Unfollow'}
          </button>
        </div>
      </motion.div>
    </>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>{text}</p>
    </div>
  );
}
