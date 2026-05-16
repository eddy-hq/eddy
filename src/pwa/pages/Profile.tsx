import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import { ChevronLeft, Plus, Trash2, X } from 'lucide-react';
import { BottomNav } from '../components/BottomNav';
import { AvatarTab } from '../components/AvatarTab';

// ── Types ────────────────────────────────────────────────────────────────────

type Expertise = 'beginner' | 'comfortable' | 'deep';
type TabKey = 'avatar' | 'interests' | 'people';

interface MyInterest {
  interestId: string;
  label: string;
  rank: number;
  expertise: Expertise;
}

interface MineResponse { interests: MyInterest[] }

interface FollowedPerson {
  person_id: string;
  display_name: string;
  person_type: string | null;
  photo_url: string | null;
  channel_id: string | null;
  followed_at: string;
}

interface FollowingResponse { following: FollowedPerson[] }

// ── API ──────────────────────────────────────────────────────────────────────

async function fetchMine(userId: string): Promise<MineResponse> {
  const res = await fetch(`/interests/mine?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load interests');
  return res.json() as Promise<MineResponse>;
}

async function reorderInterests(userId: string, interestIds: string[]): Promise<void> {
  const res = await fetch('/interests/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, interestIds }),
  });
  if (!res.ok) throw new Error('Reorder failed');
}

async function setExpertise(userId: string, interestId: string, expertise: Expertise): Promise<void> {
  const res = await fetch('/interests/expertise', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, interestId, expertise }),
  });
  if (!res.ok) throw new Error('Expertise update failed');
}

async function removeInterest(userId: string, interestId: string): Promise<void> {
  const res = await fetch('/interests/select', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, interestId }),
  });
  if (!res.ok) throw new Error('Remove failed');
}

async function addInterest(userId: string, label: string): Promise<void> {
  const res = await fetch('/interests/user-add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, label }),
  });
  if (!res.ok) throw new Error('Add failed');
}

async function fetchFollowing(userId: string): Promise<FollowingResponse> {
  const res = await fetch(`/people/following?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load people');
  return res.json() as Promise<FollowingResponse>;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function Profile() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const userId = params.get('userId') ?? params.get('user') ?? '';

  const tabParam = params.get('tab');
  const activeTab: TabKey =
    tabParam === 'people' ? 'people'
    : tabParam === 'avatar' ? 'avatar'
    : 'interests';

  function setActiveTab(tab: TabKey) {
    const next = new URLSearchParams(params);
    if (tab === 'interests') next.delete('tab');
    else next.set('tab', tab);
    setParams(next, { replace: true });
  }

  if (!userId) return <Empty text="No user selected." />;

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
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em',
            color: 'var(--text-primary)', margin: 0,
          }}>
            Profile
          </h1>
        </div>
        <TabBar active={activeTab} onChange={setActiveTab} />
      </div>

      <main style={{ paddingBottom: 120 }}>
        {activeTab === 'avatar' ? (
          <AvatarTab userId={userId} />
        ) : activeTab === 'interests' ? (
          <InterestsTab userId={userId} />
        ) : (
          <PeopleTab userId={userId} />
        )}
      </main>

      <BottomNav />
    </div>
  );
}

// ── Tab bar ──────────────────────────────────────────────────────────────────

function TabBar({ active, onChange }: { active: TabKey; onChange: (t: TabKey) => void }) {
  return (
    <div style={{ display: 'flex', padding: '0 8px' }}>
      <TabButton label="Avatar"    active={active === 'avatar'}    onClick={() => onChange('avatar')} />
      <TabButton label="Interests" active={active === 'interests'} onClick={() => onChange('interests')} />
      <TabButton label="People"    active={active === 'people'}    onClick={() => onChange('people')} />
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '12px 0',
        background: 'none', border: 'none', cursor: 'pointer',
        color: active ? 'var(--accent)' : 'var(--text-tertiary)',
        fontFamily: 'inherit',
        fontSize: 13, fontWeight: 600, letterSpacing: '0.04em',
        textTransform: 'uppercase',
        borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        transition: 'color 200ms ease, border-color 200ms ease',
      }}
    >
      {label}
    </button>
  );
}

// ── Interests tab ────────────────────────────────────────────────────────────

function InterestsTab({ userId }: { userId: string }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['my-interests', userId],
    queryFn: () => fetchMine(userId),
    enabled: !!userId,
  });

  const [order, setOrder] = useState<MyInterest[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    if (data?.interests) setOrder(data.interests);
  }, [data]);

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => reorderInterests(userId, ids),
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-interests', userId] });
    },
  });

  function handleReorder(next: MyInterest[]) {
    setOrder(next);
  }

  function handleReorderCommit() {
    const ids = order.map((i) => i.interestId);
    const previousIds = (data?.interests ?? []).map((i) => i.interestId);
    if (ids.length === previousIds.length && ids.every((id, i) => id === previousIds[i])) return;
    reorderMutation.mutate(ids);
  }

  const expertiseMutation = useMutation({
    mutationFn: (args: { interestId: string; expertise: Expertise }) =>
      setExpertise(userId, args.interestId, args.expertise),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-interests', userId] }),
  });

  const removeMutation = useMutation({
    mutationFn: (interestId: string) => removeInterest(userId, interestId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-interests', userId] });
      setActiveId(null);
    },
  });

  const addMutation = useMutation({
    mutationFn: (label: string) => addInterest(userId, label),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-interests', userId] });
      setIsAdding(false);
    },
  });

  const activeInterest = order.find((i) => i.interestId === activeId) ?? null;

  return (
    <>
      <Section title="Interests" hint="Drag to reorder. Tap to set level or remove.">
        {isLoading ? (
          <p style={{
            color: 'var(--text-tertiary)', fontSize: 13,
            padding: '0 22px', margin: 0,
          }}>
            Loading…
          </p>
        ) : (
          <InterestChips
            order={order}
            onReorder={handleReorder}
            onReorderCommit={handleReorderCommit}
            onTap={(id) => setActiveId(id)}
            onAdd={() => setIsAdding(true)}
            isAdding={isAdding}
            isAddPending={addMutation.isPending}
            onAddSubmit={(label) => addMutation.mutate(label)}
            onAddCancel={() => setIsAdding(false)}
          />
        )}
      </Section>

      <AnimatePresence>
        {activeInterest && (
          <InterestSheet
            key={activeInterest.interestId}
            interest={activeInterest}
            onClose={() => setActiveId(null)}
            onExpertise={(expertise) =>
              expertiseMutation.mutate({ interestId: activeInterest.interestId, expertise })}
            onRemove={() => removeMutation.mutate(activeInterest.interestId)}
            removePending={removeMutation.isPending}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ── People tab ───────────────────────────────────────────────────────────────

function PeopleTab({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['person-following', userId],
    queryFn: () => fetchFollowing(userId),
    enabled: !!userId,
  });

  // Forward the full current search string (userId/user, tab=people, anything
  // else) so the person page → back-to-Profile round-trip lands on the same tab.
  function go(personId: string) {
    const qs = params.toString();
    navigate(qs ? `/person/${personId}?${qs}` : `/person/${personId}`);
  }

  return (
    <Section title="People" hint="Tap a person for their page.">
      {isLoading ? (
        <p style={{
          color: 'var(--text-tertiary)', fontSize: 13,
          padding: '0 22px', margin: 0,
        }}>
          Loading…
        </p>
      ) : isError ? (
        <p style={{
          color: 'var(--text-tertiary)', fontSize: 13,
          padding: '0 22px', margin: 0, lineHeight: 1.5,
        }}>
          Couldn't load the people you follow. Pull down to retry.
        </p>
      ) : (data?.following.length ?? 0) === 0 ? (
        <p style={{
          color: 'var(--text-tertiary)', fontSize: 13,
          padding: '0 22px', margin: 0, lineHeight: 1.5,
        }}>
          You're not following anyone yet. Search for a creator to follow.
        </p>
      ) : (
        <ul style={{
          listStyle: 'none', margin: 0, padding: '4px 14px 0',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {data!.following.map((p) => (
            <li key={p.person_id}>
              <button
                onClick={() => go(p.person_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  width: '100%', padding: '10px 12px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 12,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit', textAlign: 'left',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <PersonAvatar photoUrl={p.photo_url} alt={p.display_name} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{
                    fontSize: 15, fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {p.display_name}
                  </span>
                  <span style={{
                    fontSize: 12, color: 'var(--text-tertiary)',
                  }}>
                    Following since {monthYear(p.followed_at)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function PersonAvatar({ photoUrl, alt }: { photoUrl: string | null; alt: string }) {
  const [errored, setErrored] = useState(false);
  const showImage = photoUrl && !errored;
  return (
    <span style={{
      width: 44, height: 44, borderRadius: '50%',
      overflow: 'hidden',
      background: 'var(--bg-elevated)',
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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="9" r="3.6" fill="var(--text-tertiary)" />
          <path d="M4.5 20.5c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      )}
    </span>
  );
}

function monthYear(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

// ── Section scaffolding ──────────────────────────────────────────────────────

function Section({
  title, hint, children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ padding: '24px 0 12px' }}>
      <div style={{ padding: '0 22px 10px' }}>
        <h2 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 15, fontWeight: 500, letterSpacing: '-0.003em',
          color: 'var(--text-primary)', margin: 0,
        }}>
          {title}
        </h2>
        {hint && (
          <p style={{
            margin: '4px 0 0',
            fontSize: 12, color: 'var(--text-tertiary)',
            lineHeight: 1.45,
          }}>
            {hint}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

// ── Draggable chip list ──────────────────────────────────────────────────────

function InterestChips({
  order, onReorder, onReorderCommit, onTap,
  onAdd, isAdding, isAddPending, onAddSubmit, onAddCancel,
}: {
  order: MyInterest[];
  onReorder: (next: MyInterest[]) => void;
  onReorderCommit: () => void;
  onTap: (id: string) => void;
  onAdd: () => void;
  isAdding: boolean;
  isAddPending: boolean;
  onAddSubmit: (label: string) => void;
  onAddCancel: () => void;
}) {
  return (
    <div style={{ padding: '4px 14px 0' }}>
      <Reorder.Group
        axis="y"
        values={order}
        onReorder={onReorder}
        style={{
          listStyle: 'none', padding: 0, margin: 0,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}
      >
        {order.map((interest) => (
          <InterestChip
            key={interest.interestId}
            interest={interest}
            onTap={() => onTap(interest.interestId)}
            onReorderCommit={onReorderCommit}
          />
        ))}
      </Reorder.Group>

      <div style={{ marginTop: 10 }}>
        {isAdding ? (
          <AddInput
            onSubmit={onAddSubmit}
            onCancel={onAddCancel}
            pending={isAddPending}
          />
        ) : (
          <button
            onClick={onAdd}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px', width: '100%',
              background: 'var(--bg-surface)',
              border: '1px dashed var(--border-subtle)',
              borderRadius: 12,
              color: 'var(--text-secondary)',
              fontSize: 14, fontWeight: 500, fontFamily: 'inherit',
              cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
            }}
          >
            <Plus size={16} strokeWidth={2.2} />
            Add an interest — be specific
          </button>
        )}
      </div>
    </div>
  );
}

function InterestChip({
  interest, onTap, onReorderCommit,
}: {
  interest: MyInterest;
  onTap: () => void;
  onReorderCommit: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      value={interest}
      dragListener={false}
      dragControls={dragControls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => { setDragging(false); onReorderCommit(); }}
      whileDrag={{ scale: 1.03, boxShadow: 'var(--shadow-card)' }}
      style={{
        listStyle: 'none',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        paddingRight: 12,
        display: 'flex', alignItems: 'center', gap: 4,
        WebkitTapHighlightColor: 'transparent',
        userSelect: 'none',
      }}
    >
      <DragHandle
        onPointerDown={(e) => {
          e.preventDefault();
          dragControls.start(e);
        }}
      />

      <button
        onClick={(e) => {
          if (dragging) { e.preventDefault(); return; }
          onTap();
        }}
        style={{
          flex: 1, minWidth: 0,
          display: 'flex', alignItems: 'center',
          gap: 8, padding: '14px 0',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-primary)',
          fontFamily: 'inherit', fontSize: 15, fontWeight: 500,
          letterSpacing: '-0.003em',
          textAlign: 'left',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {interest.label}
        </span>
        <ExpertiseBadge level={interest.expertise} />
      </button>
    </Reorder.Item>
  );
}

function DragHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <span
      role="button"
      aria-label="Drag to reorder"
      onPointerDown={onPointerDown}
      style={{
        flexShrink: 0,
        width: 40, height: 44,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-tertiary)',
        cursor: 'grab',
        touchAction: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{
        display: 'inline-flex', flexDirection: 'column', gap: 2,
      }}>
        <span style={{ display: 'flex', gap: 2 }}>
          <Dot /><Dot />
        </span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Dot /><Dot />
        </span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Dot /><Dot />
        </span>
      </span>
    </span>
  );
}

function Dot() {
  return (
    <span style={{
      width: 3, height: 3, borderRadius: '50%',
      background: 'currentColor', display: 'block',
    }} />
  );
}

function ExpertiseBadge({ level }: { level: Expertise }) {
  const label = level[0].toUpperCase() + level.slice(1);
  const color = level === 'deep' ? 'var(--accent)'
    : level === 'beginner' ? 'var(--text-tertiary)'
    : 'var(--text-secondary)';
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
      textTransform: 'uppercase', color,
      padding: '3px 8px', borderRadius: 999,
      background: level === 'deep' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

// ── Add input ────────────────────────────────────────────────────────────────

function AddInput({
  onSubmit, onCancel, pending,
}: {
  onSubmit: (label: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || pending) return;
    onSubmit(trimmed);
    setValue('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', minWidth: 0,
        padding: '8px 10px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--accent)',
        borderRadius: 12,
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. minecraft redstone"
        disabled={pending}
        size={1}
        style={{
          flex: 1, minWidth: 0, width: '100%',
          border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'inherit', fontSize: 16, fontWeight: 500,
          color: 'var(--text-primary)',
          padding: '6px 4px',
        }}
      />
      <button
        type="submit"
        disabled={pending || !value.trim()}
        style={{
          padding: '8px 14px', borderRadius: 8,
          background: 'var(--accent)', color: '#fff',
          border: 'none', cursor: pending ? 'default' : 'pointer',
          fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
          opacity: pending || !value.trim() ? 0.5 : 1,
        }}
      >
        {pending ? 'Adding…' : 'Add'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        style={{
          width: 32, height: 32, borderRadius: '50%',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <X size={16} strokeWidth={2.2} />
      </button>
    </form>
  );
}

// ── Bottom sheet (expertise + remove) ────────────────────────────────────────

function InterestSheet({
  interest, onClose, onExpertise, onRemove, removePending,
}: {
  interest: MyInterest;
  onClose: () => void;
  onExpertise: (e: Expertise) => void;
  onRemove: () => void;
  removePending: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [localExpertise, setLocalExpertise] = useState<Expertise>(interest.expertise);

  useEffect(() => { setLocalExpertise(interest.expertise); }, [interest.expertise]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function selectExpertise(level: Expertise) {
    setLocalExpertise(level);
    onExpertise(level);
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        aria-hidden
        style={{ position: 'fixed', inset: 0, zIndex: 49, background: 'rgba(0,0,0,0.42)' }}
      />

      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ duration: 0.28, ease: [0.33, 1, 0.68, 1] }}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.4 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 80 || info.velocity.y > 500) onClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-label={interest.label}
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
          margin: '0 auto 14px',
        }} />

        <div style={{ marginBottom: 22 }}>
          <h2 style={{
            fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 500,
            letterSpacing: '-0.01em', margin: 0, color: 'var(--text-primary)',
          }}>
            {interest.label}
          </h2>
        </div>

        <p style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--text-tertiary)',
          margin: '0 0 10px',
        }}>
          Your level
        </p>

        <div style={{
          display: 'flex', gap: 8, marginBottom: 24,
        }}>
          {(['beginner', 'comfortable', 'deep'] as const).map((level) => {
            const selected = localExpertise === level;
            return (
              <button
                key={level}
                onClick={() => selectExpertise(level)}
                style={{
                  flex: 1, padding: '12px 0',
                  borderRadius: 10,
                  background: selected ? 'var(--accent-subtle)' : 'var(--bg-surface)',
                  border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  color: selected ? 'var(--accent)' : 'var(--text-secondary)',
                  fontFamily: 'inherit',
                  fontSize: 13, fontWeight: 600, letterSpacing: '0.01em',
                  cursor: 'pointer',
                  transition: 'background 200ms ease, color 200ms ease, border-color 200ms ease',
                  textTransform: 'capitalize',
                }}
              >
                {level}
              </button>
            );
          })}
        </div>

        {confirmRemove ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{
              flex: 1, fontSize: 13, color: 'var(--text-secondary)',
            }}>
              Remove this interest?
            </span>
            <button
              onClick={() => setConfirmRemove(false)}
              style={{
                padding: '10px 14px', borderRadius: 10,
                background: 'var(--bg-surface)', border: '1.5px solid var(--border-subtle)',
                color: 'var(--text-secondary)', fontFamily: 'inherit',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={onRemove}
              disabled={removePending}
              style={{
                padding: '10px 14px', borderRadius: 10,
                background: 'var(--dismiss)', border: 'none',
                color: '#fff', fontFamily: 'inherit',
                fontSize: 13, fontWeight: 600,
                cursor: removePending ? 'default' : 'pointer',
                opacity: removePending ? 0.6 : 1,
              }}
            >
              {removePending ? 'Removing…' : 'Yes, remove'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmRemove(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 16px', width: '100%',
              background: 'var(--bg-surface)',
              border: '1.5px solid var(--border-subtle)',
              borderRadius: 12,
              color: 'var(--text-secondary)',
              fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
              cursor: 'pointer',
              justifyContent: 'center',
            }}
          >
            <Trash2 size={16} strokeWidth={2.2} />
            Remove
          </button>
        )}
      </motion.div>
    </>
  );
}

// ── Fallback ─────────────────────────────────────────────────────────────────

function Empty({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>{text}</p>
    </div>
  );
}
