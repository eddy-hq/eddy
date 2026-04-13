import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

interface RequestRow {
  request_id: string;
  title: string | null;
  url: string;
  status: string;
  rejection_reason: string | null;
  nginx_url: string | null;
  requested_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending:       'Pending',
  guard_review:  'Reviewing…',
  parent_review: 'Waiting for a grown-up',
  approved:      'Approved',
  downloading:   'Getting it…',
  ready:         'Ready',
  watched:       'Watched',
  dismissed:     'Dismissed',
  rejected:      'Not available',
};

export function MyRequests() {
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? '';

  const [rows, setRows] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setError('No userId in URL.');
      setLoading(false);
      return;
    }

    fetch(`/requests?userId=${encodeURIComponent(userId)}`)
      .then((r) => r.json())
      .then((data: { requests?: RequestRow[]; message?: string }) => {
        if (data.requests) setRows(data.requests);
        else setError(data.message ?? 'Failed to load.');
      })
      .catch(() => setError('Could not reach Eddy.'))
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) return <CentredMessage text="Loading…" />;
  if (error)   return <CentredMessage text={error} />;
  if (!rows.length) return <CentredMessage text="No requests yet." />;

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 'var(--space-4)' }}>My requests</h1>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {rows.map((row) => (
          <li key={row.request_id} style={{ background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <p style={{ fontSize: 15, fontWeight: 500, lineHeight: 1.3, flex: 1 }}>
                {row.title ?? row.url}
              </p>
              <span style={{ fontSize: 12, color: statusColour(row.status), whiteSpace: 'nowrap', paddingTop: 2 }}>
                {STATUS_LABEL[row.status] ?? row.status}
              </span>
            </div>
            {row.status === 'rejected' && row.rejection_reason && (
              <p style={{ marginTop: 4, fontSize: 13, color: 'var(--text-tertiary)' }}>{row.rejection_reason}</p>
            )}
            {row.status === 'ready' && row.nginx_url && (
              <a href={row.nginx_url} style={{ display: 'inline-block', marginTop: 8, fontSize: 13, color: 'var(--accent)', fontWeight: 500 }}>
                Watch →
              </a>
            )}
            <p style={{ marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)' }}>
              {new Date(row.requested_at).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusColour(status: string): string {
  if (status === 'ready') return 'var(--accent)';
  if (status === 'rejected') return '#B85450';
  if (['downloading', 'guard_review', 'parent_review', 'pending', 'approved'].includes(status)) return 'var(--text-secondary)';
  return 'var(--text-tertiary)';
}

function CentredMessage({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 15 }}>{text}</p>
    </div>
  );
}
