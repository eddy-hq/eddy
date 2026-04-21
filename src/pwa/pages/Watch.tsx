import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { VideoPlayer } from '../components/VideoPlayer';

interface RequestData {
  requestId: string;
  status: string;
  progress: number | null;
  title: string | null;
  rejectionReason: string | null;
  videoUrl: string | null;
}

async function fetchRequest(id: string): Promise<RequestData> {
  const res = await fetch(`/requests/${id}`);
  if (!res.ok) throw new Error('Not found');
  return res.json() as Promise<RequestData>;
}

async function deleteRequest(id: string): Promise<void> {
  const res = await fetch(`/requests/${id}/delete`, { method: 'POST' });
  if (!res.ok) throw new Error('Delete failed');
}

export function Watch() {
  const { requestId } = useParams<{ requestId: string }>();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteRequest(requestId!),
    onSuccess: () => navigate(-1),
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['request', requestId],
    queryFn: () => fetchRequest(requestId!),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'ready' || status === 'rejected' ? false : 3000;
    },
    enabled: !!requestId,
  });


  if (isLoading) return <Screen><Spinner /></Screen>;
  if (isError || !data) return <Screen><Message text="Request not found." /></Screen>;

  if (data.status === 'rejected') {
    return (
      <Screen>
        <Message text={data.rejectionReason ?? "Eddy can't get this one."} />
      </Screen>
    );
  }

  if (data.status === 'deleted') {
    return (
      <Screen>
        <Message text="This video has been deleted." />
      </Screen>
    );
  }

  if (!['ready', 'watched'].includes(data.status) || !data.videoUrl) {
    return (
      <Screen>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-lg)', marginBottom: 'var(--space-3)' }}>
            {data.title ?? 'Getting it…'}
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-4)' }}>
            {statusLabel(data.status)}
          </p>
          {typeof data.progress === 'number' && (
            <ProgressBar pct={data.progress} />
          )}
        </div>
      </Screen>
    );
  }

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>
      {/* Back button */}
      <div style={{ padding: 'var(--space-4)', paddingBottom: 0 }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            color: 'var(--text-secondary)',
            fontSize: 'var(--text-sm)',
            minHeight: 44,
          }}
        >
          <ArrowLeft size={16} />
          Back
        </button>
      </div>

      {/* Player */}
      <div style={{ padding: 'var(--space-4)' }}>
        <VideoPlayer src={data.videoUrl} title={data.title ?? 'Video'} />
        {data.title && (
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 'var(--text-lg)',
            fontWeight: 600,
            marginTop: 'var(--space-4)',
            lineHeight: 1.3,
          }}>
            {data.title}
          </h1>
        )}

        <div style={{ marginTop: 'var(--space-5)', borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--space-4)' }}>
          {confirmDelete ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                Delete this video?
              </span>
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--destructive, #e53e3e)',
                  fontWeight: 600,
                  minHeight: 44,
                  padding: '0 var(--space-2)',
                }}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)',
                  minHeight: 44,
                  padding: '0 var(--space-2)',
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                color: 'var(--text-tertiary, var(--text-secondary))',
                fontSize: 'var(--text-sm)',
                minHeight: 44,
              }}
            >
              <Trash2 size={16} />
              Delete
            </button>
          )}
        </div>

      </div>
    </div>
  );
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Waiting to start…',
    guard_review: 'Reviewing…',
    parent_review: 'Waiting for a grown-up…',
    approved: 'Approved, starting soon…',
    downloading: 'Downloading…',
  };
  return labels[status] ?? 'Working on it…';
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--space-6)',
    }}>
      {children}
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)', textAlign: 'center' }}>{text}</p>;
}

function Spinner() {
  return (
    <div style={{ width: 24, height: 24, border: '2px solid var(--border-subtle)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ height: 3, background: 'var(--border-subtle)', borderRadius: 2, overflow: 'hidden', maxWidth: 240, margin: '0 auto' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width 0.5s ease' }} />
    </div>
  );
}
