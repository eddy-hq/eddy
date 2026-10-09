import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  guessDeviceType,
  inviteFromSearch,
  parseSetupInput,
  reconcileIdentitySearch,
} from '../lib/deviceIdentity';

// Nothing renders until the server has said who this device is (ADR-0016).
// The credential is an HttpOnly cookie the PWA never sees: GET /devices/me
// answers 401 for a device that isn't set up, and the person gets the setup
// screen instead of a page of failed fetches. `/setup?invite=` redeems an
// invite and lands on the feed.

interface Me {
  userId: string;
}

type GateState =
  | { kind: 'checking' }
  | { kind: 'ready'; me: Me }
  | { kind: 'not_set_up'; message: string | null }
  | { kind: 'unreachable' };

async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/devices/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`devices/me answered ${res.status}`);
  return (await res.json()) as Me;
}

async function redeem(invite: string): Promise<{ ok: true; me: Me } | { ok: false; message: string }> {
  const res = await fetch('/devices/enrol', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite, deviceType: guessDeviceType(navigator.userAgent) }),
  });
  const body = (await res.json().catch(() => ({}))) as { userId?: string; message?: string };
  if (res.ok && body.userId) return { ok: true, me: { userId: body.userId } };
  return { ok: false, message: body.message ?? 'That setup link didn’t work. Ask a parent for a new one.' };
}

export function DeviceGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<GateState>({ kind: 'checking' });

  const enrol = useCallback(
    async (invite: string) => {
      setState({ kind: 'checking' });
      try {
        const out = await redeem(invite);
        if (!out.ok) {
          setState({ kind: 'not_set_up', message: out.message });
          return;
        }
        setState({ kind: 'ready', me: out.me });
        navigate(`/feed?userId=${encodeURIComponent(out.me.userId)}`, { replace: true });
      } catch {
        setState({ kind: 'unreachable' });
      }
    },
    [navigate],
  );

  const check = useCallback(async () => {
    setState({ kind: 'checking' });
    try {
      const me = await fetchMe();
      setState(me ? { kind: 'ready', me } : { kind: 'not_set_up', message: null });
    } catch {
      setState({ kind: 'unreachable' });
    }
  }, []);

  // Once, on load. An invite in the address wins over an existing credential:
  // opening a new link is how a device is moved to another person. The ref
  // keeps StrictMode's development double-run from spending the invite twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const invite = location.pathname === '/setup' ? inviteFromSearch(location.search) : null;
    void (invite ? enrol(invite) : check());
  }, []);

  if (state.kind === 'checking') return <GateScreen title="Eddy" body="Checking this device…" />;
  if (state.kind === 'unreachable') {
    return (
      <GateScreen title="Couldn’t reach Eddy" body="Check Tailscale is connected, then try again.">
        <button className="gate-button" onClick={() => void check()}>Try again</button>
      </GateScreen>
    );
  }
  if (state.kind === 'not_set_up') return <SetupScreen message={state.message} onInvite={enrol} />;

  if (location.pathname === '/setup') {
    return <Navigate to={`/feed?userId=${encodeURIComponent(state.me.userId)}`} replace />;
  }
  const fixed = reconcileIdentitySearch(location.search, state.me.userId);
  if (fixed !== null) return <Navigate to={`${location.pathname}${fixed}${location.hash}`} replace />;

  return <>{children}</>;
}

function SetupScreen({ message, onInvite }: { message: string | null; onInvite: (invite: string) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const invite = parseSetupInput(input);
    if (!invite) {
      setError('That doesn’t look like an Eddy setup link.');
      return;
    }
    setError(null);
    onInvite(invite);
  }

  return (
    <GateScreen
      title="Set up this device"
      body="Eddy doesn’t know this device yet. Ask a parent for a setup link, then open it here — or paste it below."
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Setup link"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            font: 'inherit',
            fontSize: 'var(--text-sm)',
          }}
        />
        <button className="gate-button" type="submit" disabled={!input.trim()}>Connect</button>
        <p style={{ minHeight: '1.5em', margin: 0, color: 'var(--dismiss)', fontSize: 'var(--text-sm)' }}>
          {error ?? message ?? ''}
        </p>
      </form>
    </GateScreen>
  );
}

function GateScreen({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: '100dvh',
        boxSizing: 'border-box',
        padding: '56px 24px',
        maxWidth: 520,
        margin: '0 auto',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    >
      <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-xl)', margin: 0 }}>{title}</h1>
      <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 12 }}>{body}</p>
      {children}
    </main>
  );
}
