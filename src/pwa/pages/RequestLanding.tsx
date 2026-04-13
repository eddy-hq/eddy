import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

type Status = 'submitting' | 'downloading' | 'ready' | 'rejected' | 'error';

interface RequestState {
  requestId: string;
  status: Status;
  title: string | null;
  progress: number | null;
  rejectionReason: string | null;
  videoUrl: string | null;
}

const STATUS_LABEL: Record<Status, string> = {
  submitting:  'Sending to Eddy…',
  downloading: 'Getting it…',
  ready:       'Ready to watch',
  rejected:    'Eddy can\'t get this one',
  error:       'Something went wrong',
};

export function RequestLanding() {
  const [params] = useSearchParams();
  const url = params.get('url') ?? '';
  const user = params.get('user') ?? '';

  const [state, setState] = useState<RequestState | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Submit the request on mount
  useEffect(() => {
    if (!url) {
      setSubmitError('No URL provided.');
      return;
    }

    let cancelled = false;

    async function submit() {
      try {
        const resp = await fetch('/requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, user: user || undefined }),
        });
        const data = await resp.json() as { requestId?: string; status?: string; message?: string; error?: string };

        if (!resp.ok || !data.requestId) {
          setSubmitError(data.message ?? data.error ?? 'Request failed.');
          return;
        }

        if (!cancelled) {
          setState({
            requestId: data.requestId,
            status: (data.status as Status) ?? 'downloading',
            title: null,
            progress: null,
            rejectionReason: null,
            videoUrl: null,
          });
        }
      } catch {
        if (!cancelled) setSubmitError('Could not reach Eddy.');
      }
    }

    void submit();
    return () => { cancelled = true; };
  }, [url, user]);

  // Poll for status while downloading
  useEffect(() => {
    if (!state?.requestId || state.status === 'ready' || state.status === 'rejected' || state.status === 'error') return;

    const id = setInterval(async () => {
      try {
        const resp = await fetch(`/requests/${state.requestId}`);
        const data = await resp.json() as {
          status?: string; title?: string; progress?: number;
          rejectionReason?: string; videoUrl?: string;
        };
        setState((prev) => prev ? {
          ...prev,
          status: (data.status as Status) ?? prev.status,
          title: data.title ?? prev.title,
          progress: data.progress ?? prev.progress,
          rejectionReason: data.rejectionReason ?? prev.rejectionReason,
          videoUrl: data.videoUrl ?? prev.videoUrl,
        } : prev);
      } catch {
        // transient — keep polling
      }
    }, 3000);

    return () => clearInterval(id);
  }, [state?.requestId, state?.status]);

  if (submitError) {
    return <Screen title="Couldn't send that" detail={submitError} />;
  }

  if (!state) {
    return <Screen title="Sending to Eddy…" />;
  }

  const label = STATUS_LABEL[state.status];
  const detail = state.title ?? url;

  if (state.status === 'ready' && state.videoUrl) {
    return (
      <Screen title={label} detail={detail}>
        <a href={state.videoUrl} style={{ marginTop: 24, display: 'inline-block', padding: '12px 24px', background: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-md)', fontWeight: 600 }}>
          Watch now
        </a>
      </Screen>
    );
  }

  if (state.status === 'rejected') {
    return (
      <Screen title={label} detail={state.rejectionReason ?? ''}>
        <p style={{ marginTop: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
          You can ask a grown-up to approve it.
        </p>
      </Screen>
    );
  }

  return (
    <Screen title={label} detail={detail}>
      {typeof state.progress === 'number' && (
        <ProgressBar pct={state.progress} />
      )}
    </Screen>
  );
}

function Screen({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)', textAlign: 'center' }}>
      <div style={{ maxWidth: 360, width: '100%' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>{title}</h1>
        {detail && <p style={{ color: 'var(--text-secondary)', fontSize: 15, lineHeight: 1.4 }}>{detail}</p>}
        {children}
      </div>
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ marginTop: 24, height: 4, background: 'var(--border-subtle)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width 0.5s ease' }} />
    </div>
  );
}
