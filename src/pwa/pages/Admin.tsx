import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppHeader } from '../components/AppHeader';

// ── Types ────────────────────────────────────────────────────────────────────

interface PipelineItem {
  request_id: string;
  url: string;
  youtube_id: string | null;
  title: string | null;
  status: string;
  rejection_reason: string | null;
  requested_at: string;
  user_name: string;
  jobState?: string | null;
  progress?: number | null;
}

interface PipelineResponse {
  active: PipelineItem[];
  recentFailures: PipelineItem[];
}

// ── API ──────────────────────────────────────────────────────────────────────

async function fetchPipeline(): Promise<PipelineResponse> {
  const res = await fetch('/requests/admin/pipeline');
  if (!res.ok) throw new Error('Failed to load pipeline');
  return res.json() as Promise<PipelineResponse>;
}

async function cancelRequest(id: string): Promise<void> {
  const res = await fetch(`/requests/${id}/cancel`, { method: 'POST' });
  if (!res.ok && res.status !== 409) throw new Error(`Cancel failed: ${res.status}`);
}

async function deleteRequest(id: string): Promise<void> {
  const res = await fetch(`/requests/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

async function retryRequest(id: string): Promise<void> {
  const res = await fetch(`/requests/admin/${id}/retry`, { method: 'POST' });
  if (!res.ok) throw new Error(`Retry failed: ${res.status}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLOUR: Record<string, string> = {
  downloading:   '#4E8A8A',
  guard_review:  '#9370C8',
  parent_review: '#E07C3A',
  pending:       '#9A9890',
  approved:      '#3A7D5A',
  rejected:      '#B85450',
  failed:        '#B85450',
};

// Statuses that the `retry` transition (RETRY_SOURCES) accepts: a stuck
// `downloading` row (manual nudge ahead of the watchdog) or a `failed` row
// that escalated past the watchdog. `rejected` is terminal — no retry.
const RETRYABLE = new Set(['downloading', 'failed']);

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace('www.', '') + u.pathname.slice(0, 24);
  } catch {
    return url.slice(0, 40);
  }
}

// ── Row component ─────────────────────────────────────────────────────────────

function PipelineRow({
  item,
  onAction,
}: {
  item: PipelineItem;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState<'cancel' | 'delete' | 'retry' | null>(null);
  const isActive = ['downloading', 'guard_review', 'parent_review', 'pending', 'approved'].includes(item.status);
  const isRetryable = RETRYABLE.has(item.status);

  async function handleCancel() {
    setBusy('cancel');
    try { await cancelRequest(item.request_id); onAction(); }
    catch { setBusy(null); }
  }

  async function handleDelete() {
    setBusy('delete');
    try { await deleteRequest(item.request_id); onAction(); }
    catch { setBusy(null); }
  }

  async function handleRetry() {
    setBusy('retry');
    try { await retryRequest(item.request_id); onAction(); }
    catch { setBusy(null); }
  }

  const statusColour = STATUS_COLOUR[item.status] ?? '#9A9890';
  const label = item.title ?? shortUrl(item.url);

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      {/* Status pill */}
      <span style={{
        flexShrink: 0, marginTop: 2,
        fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
        padding: '3px 7px', borderRadius: 20,
        color: statusColour,
        background: `${statusColour}18`,
        whiteSpace: 'nowrap',
      }}>
        {item.status.replace('_', ' ')}
        {item.status === 'downloading' && item.progress != null ? ` ${item.progress}%` : ''}
      </span>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 3,
        }}>
          {label}
        </p>
        <p style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          {item.user_name} · {timeAgo(item.requested_at)}
          {item.jobState ? ` · queue: ${item.jobState}` : ''}
          {item.rejection_reason ? ` · ${item.rejection_reason}` : ''}
        </p>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
        {isRetryable && (
          <button
            onClick={handleRetry}
            disabled={!!busy}
            style={{
              fontSize: 12, fontWeight: 500, padding: '5px 10px',
              borderRadius: 8, border: '1px solid var(--border-subtle)',
              color: busy === 'retry' ? 'var(--text-tertiary)' : '#4E8A8A',
              background: 'none', cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy === 'retry' ? '…' : 'Retry'}
          </button>
        )}
        {isActive && (
          <button
            onClick={handleCancel}
            disabled={!!busy}
            style={{
              fontSize: 12, fontWeight: 500, padding: '5px 10px',
              borderRadius: 8, border: '1px solid var(--border-subtle)',
              color: busy === 'cancel' ? 'var(--text-tertiary)' : 'var(--dismiss)',
              background: 'none', cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy === 'cancel' ? '…' : 'Cancel'}
          </button>
        )}
        <button
          onClick={handleDelete}
          disabled={!!busy}
          style={{
            fontSize: 12, fontWeight: 500, padding: '5px 10px',
            borderRadius: 8, border: '1px solid var(--border-subtle)',
            color: busy === 'delete' ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            background: 'none', cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy === 'delete' ? '…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Admin() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-pipeline'],
    queryFn: fetchPipeline,
    refetchInterval: 5_000,
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['admin-pipeline'] });
  }

  const active = data?.active ?? [];
  const failures = data?.recentFailures ?? [];

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)' }}>
        <AppHeader />
      </div>

      <div style={{ maxWidth: 680, margin: '0 auto', padding: '20px 20px 80px' }}>
        <h1 style={{
          fontFamily: 'var(--font-serif)', fontSize: 26, fontWeight: 400,
          letterSpacing: '-0.01em', color: 'var(--text-primary)', marginBottom: 4,
        }}>
          Pipeline
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic', fontFamily: 'var(--font-serif)', marginBottom: 24 }}>
          Active downloads and recent failures. Refreshes every 5s.
        </p>

        {isLoading && <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</p>}
        {isError  && <p style={{ color: 'var(--dismiss)',      fontSize: 13 }}>Could not load pipeline.</p>}

        {/* Active */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
            <h2 style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-primary)' }}>
              Active
            </h2>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{active.length}</span>
          </div>
          {active.length === 0 && !isLoading ? (
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' }}>Nothing in the pipeline.</p>
          ) : (
            active.map((item) => (
              <PipelineRow key={item.request_id} item={item} onAction={refresh} />
            ))
          )}
        </section>

        {/* Recent failures */}
        {failures.length > 0 && (
          <section>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
              <h2 style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-primary)' }}>
                Recent failures
              </h2>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>last 24h</span>
            </div>
            {failures.map((item) => (
              <PipelineRow key={item.request_id} item={item} onAction={refresh} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
