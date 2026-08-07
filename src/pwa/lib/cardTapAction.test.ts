import { describe, it, expect } from 'vitest';
import { cardTapAction, type CardTapState } from './cardTapAction';

// Base: an ordinary playable card; each test overrides the fields it cares about.
function state(overrides: Partial<CardTapState> = {}): CardTapState {
  return {
    status: 'ready',
    fileState: 'live',
    nginxUrl: 'http://m4/videos/abc.mp4',
    downloadDone: false,
    isRestoring: false,
    retryInFlight: false,
    ...overrides,
  };
}

describe('cardTapAction', () => {
  it('plays a ready live card', () => {
    expect(cardTapAction(state())).toBe('play');
  });

  it('plays a watched live card', () => {
    expect(cardTapAction(state({ status: 'watched' }))).toBe('play');
  });

  it('is inert for a ready card with no stream URL', () => {
    expect(cardTapAction(state({ nginxUrl: null }))).toBeNull();
  });

  it('restores a recycled card, and is inert while restoring', () => {
    expect(cardTapAction(state({ fileState: 'recycled', nginxUrl: null }))).toBe('restore');
    expect(cardTapAction(state({ fileState: 'recycled', nginxUrl: null, isRestoring: true }))).toBeNull();
  });

  it('retries a failed card, and is inert while the retry is in flight', () => {
    expect(cardTapAction(state({ status: 'failed', nginxUrl: null }))).toBe('retry');
    expect(cardTapAction(state({ status: 'failed', nginxUrl: null, retryInFlight: true }))).toBeNull();
  });

  it('plays a failed card once the manual download completes (stale status)', () => {
    // After a retry the card keeps status='failed' until the next feed fetch;
    // downloadDone from the poll must win over the retry affordance.
    expect(cardTapAction(state({ status: 'failed', nginxUrl: null, downloadDone: true }))).toBe('play');
  });

  it('plays a downloading card once the poll reports done', () => {
    expect(cardTapAction(state({ status: 'downloading', nginxUrl: null, downloadDone: true }))).toBe('play');
  });

  it('is inert mid-download and for rejected / gone rows', () => {
    expect(cardTapAction(state({ status: 'downloading', nginxUrl: null }))).toBeNull();
    expect(cardTapAction(state({ status: 'rejected', nginxUrl: null }))).toBeNull();
    expect(cardTapAction(state({ fileState: 'gone', nginxUrl: null }))).toBeNull();
  });
});
