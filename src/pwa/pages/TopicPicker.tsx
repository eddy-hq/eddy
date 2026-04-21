import React, { useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Topic {
  id: string;
  label: string;
  emoji: string | null;
  selected: boolean;
}

interface Category {
  name: string;
  topics: Topic[];
}

interface TopicsResponse {
  categories: Category[];
  selected_count: number;
}

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchTopics(userId: string): Promise<TopicsResponse> {
  const res = await fetch(`/topics?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load topics');
  return res.json() as Promise<TopicsResponse>;
}

async function toggleTopic(userId: string, topicId: string, selected: boolean): Promise<void> {
  await fetch('/topics/select', {
    method: selected ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, topicId }),
  });
}

async function addUserTopic(userId: string, label: string): Promise<{ topicId: string; label: string }> {
  const res = await fetch('/topics/user-add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, label }),
  });
  if (!res.ok) throw new Error('Failed to add topic');
  return res.json() as Promise<{ topicId: string; label: string }>;
}

// ── Pill ──────────────────────────────────────────────────────────────────────

function TopicPill({
  topic,
  onToggle,
}: {
  topic: Topic;
  onToggle: (id: string, selected: boolean) => void;
}) {
  return (
    <motion.button
      layout
      whileTap={{ scale: 0.91 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      onClick={() => onToggle(topic.id, topic.selected)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '8px 14px',
        borderRadius: 24,
        fontSize: 14,
        fontFamily: 'var(--font-sans)',
        fontWeight: topic.selected ? 600 : 500,
        letterSpacing: '0.01em',
        cursor: 'pointer',
        border: `1.5px solid ${topic.selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
        background: topic.selected ? 'var(--accent)' : 'transparent',
        color: topic.selected ? '#fff' : 'var(--text-secondary)',
        transition: 'background 160ms ease, border-color 160ms ease, color 160ms ease',
        WebkitTapHighlightColor: 'transparent',
        userSelect: 'none',
      }}
      aria-pressed={topic.selected}
    >
      {topic.label}
    </motion.button>
  );
}

// ── Add-your-own ──────────────────────────────────────────────────────────────

function AddTopicInput({ userId }: { userId: string }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { mutate, isPending, isError } = useMutation({
    mutationFn: (label: string) => addUserTopic(userId, label),
    onSuccess: () => {
      setValue('');
      void queryClient.invalidateQueries({ queryKey: ['topics', userId] });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    mutate(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Something else…"
        maxLength={60}
        style={{
          flex: 1,
          height: 42,
          padding: '0 14px',
          borderRadius: 12,
          border: `1.5px solid ${isError ? 'var(--dismiss)' : 'var(--border-subtle)'}`,
          background: 'var(--bg-surface)',
          color: 'var(--text-primary)',
          fontSize: 14,
          fontFamily: 'var(--font-sans)',
          outline: 'none',
        }}
      />
      <motion.button
        type="submit"
        whileTap={{ scale: 0.93 }}
        disabled={!value.trim() || isPending}
        style={{
          height: 42,
          padding: '0 18px',
          borderRadius: 12,
          border: 'none',
          background: 'var(--accent)',
          color: '#fff',
          fontSize: 14,
          fontWeight: 600,
          fontFamily: 'var(--font-sans)',
          cursor: value.trim() && !isPending ? 'pointer' : 'not-allowed',
          opacity: value.trim() && !isPending ? 1 : 0.45,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {isPending ? '…' : 'Add'}
      </motion.button>
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function TopicPicker() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const userId = params.get('userId') ?? '';
  const returnTo = params.get('returnTo') ?? `/feed?userId=${encodeURIComponent(userId)}`;
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['topics', userId],
    queryFn: () => fetchTopics(userId),
    enabled: !!userId,
  });

  const { mutate: toggle } = useMutation({
    mutationFn: ({ topicId, selected }: { topicId: string; selected: boolean }) =>
      toggleTopic(userId, topicId, selected),
    onMutate: async ({ topicId, selected }) => {
      await queryClient.cancelQueries({ queryKey: ['topics', userId] });
      const prev = queryClient.getQueryData<TopicsResponse>(['topics', userId]);
      queryClient.setQueryData<TopicsResponse>(['topics', userId], (old) => {
        if (!old) return old;
        return {
          ...old,
          selected_count: old.selected_count + (selected ? -1 : 1),
          categories: old.categories.map((cat) => ({
            ...cat,
            topics: cat.topics.map((t) =>
              t.id === topicId ? { ...t, selected: !selected } : t
            ),
          })),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['topics', userId], ctx.prev);
    },
  });

  function handleToggle(topicId: string, currentlySelected: boolean) {
    toggle({ topicId, selected: currentlySelected });
  }

  if (!userId) return <FullPageMessage text="No user selected." />;
  if (isLoading) return <FullPageMessage text="Loading…" />;
  if (isError) return <FullPageMessage text="Could not load topics." />;

  const selectedCount = data?.selected_count ?? 0;

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column' }}>

      {/* Header */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border-subtle)',
        padding: '16px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-sans)', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            What are you into?
          </h1>
          <AnimatePresence mode="wait">
            <motion.p
              key={selectedCount}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}
            >
              {selectedCount === 0
                ? 'Pick at least one to get started'
                : `${selectedCount} selected`}
            </motion.p>
          </AnimatePresence>
        </div>

        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => navigate(returnTo)}
          style={{
            flexShrink: 0,
            height: 38,
            padding: '0 20px',
            borderRadius: 20,
            border: 'none',
            background: selectedCount > 0 ? 'var(--accent)' : 'var(--bg-elevated)',
            color: selectedCount > 0 ? '#fff' : 'var(--text-tertiary)',
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
            transition: 'background 200ms ease, color 200ms ease',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Done
        </motion.button>
      </div>

      {/* Categories */}
      <main style={{ flex: 1, padding: '4px 20px 120px' }}>
        {data?.categories.map((cat) => (
          <section key={cat.name} style={{ marginTop: 28 }}>
            <p style={{
              margin: '0 0 12px',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-sans)',
            }}>
              {cat.name}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {cat.topics.map((topic) => (
                <TopicPill key={topic.id} topic={topic} onToggle={handleToggle} />
              ))}
            </div>
          </section>
        ))}

        {/* User-added */}
        <section style={{ marginTop: 36 }}>
          <p style={{
            margin: '0 0 12px',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-sans)',
          }}>
            Add your own
          </p>
          <AddTopicInput userId={userId} />
        </section>
      </main>
    </div>
  );
}

function FullPageMessage({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 15, fontFamily: 'var(--font-sans)' }}>{text}</p>
    </div>
  );
}
