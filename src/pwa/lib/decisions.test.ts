import { describe, expect, it } from 'vitest';
import {
  agreement,
  decisionsForCard,
  formatScores,
  keyAction,
  removeDecided,
  skipCard,
  type CardSubject,
  type DecisionCard,
} from './decisions';

function subject(id: string, userId: string): CardSubject {
  return { subjectType: 'candidate', subjectId: id, userId, kidName: userId, ageBand: '10-12', guard: null };
}

function card(key: string, subjects: CardSubject[]): DecisionCard {
  return {
    key, source: 'escalation', url: `https://example.test/${key}`, youtubeId: key, title: key,
    channel: null, description: '', thumbnailUrl: null, addedAt: '2026-09-25T00:00:00.000Z', subjects,
  };
}

describe('decisionsForCard', () => {
  const both = card('v1', [subject('s1', 'kid1'), subject('s2', 'kid2')]);

  it('decides every kid on the card by default', () => {
    expect(decisionsForCard(both, 'clear_no')).toEqual([
      { subjectType: 'candidate', subjectId: 's1', verdict: 'clear_no' },
      { subjectType: 'candidate', subjectId: 's2', verdict: 'clear_no' },
    ]);
  });

  it('decides one kid when named', () => {
    expect(decisionsForCard(both, 'clear_yes', 'kid2')).toEqual([
      { subjectType: 'candidate', subjectId: 's2', verdict: 'clear_yes' },
    ]);
  });
});

describe('removeDecided', () => {
  it('keeps a card until every kid on it is decided', () => {
    const cards = [card('v1', [subject('s1', 'kid1'), subject('s2', 'kid2')]), card('v2', [subject('s3', 'kid1')])];
    const afterOne = removeDecided(cards, new Set(['s1']));
    expect(afterOne.map((c) => c.subjects.map((s) => s.subjectId))).toEqual([['s2'], ['s3']]);
    expect(removeDecided(cards, new Set(['s1', 's2'])).map((c) => c.key)).toEqual(['v2']);
  });
});

describe('skipCard', () => {
  it('moves the card to the back', () => {
    const cards = [card('a', [subject('1', 'k')]), card('b', [subject('2', 'k')]), card('c', [subject('3', 'k')])];
    expect(skipCard(cards, 'a').map((c) => c.key)).toEqual(['b', 'c', 'a']);
    expect(skipCard(cards, 'missing').map((c) => c.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('keyAction', () => {
  it('maps a, b and s when deciding', () => {
    expect(keyAction('a', false)).toBe('allow');
    expect(keyAction('B', false)).toBe('block');
    expect(keyAction('s', false)).toBe('skip');
    expect(keyAction('Enter', false)).toBeNull();
  });

  it('only continues while a reveal is showing', () => {
    expect(keyAction('a', true)).toBeNull();
    expect(keyAction('b', true)).toBeNull();
    expect(keyAction('Enter', true)).toBe('next');
    expect(keyAction(' ', true)).toBe('next');
  });
});

describe('agreement', () => {
  it('compares against a clear verdict only', () => {
    expect(agreement('clear_yes', 'clear_yes')).toBe('agree');
    expect(agreement('clear_no', 'clear_yes')).toBe('disagree');
    expect(agreement('clear_no', 'uncertain')).toBe('none');
    expect(agreement('clear_no', null)).toBe('none');
  });
});

describe('formatScores', () => {
  it('lists dimensions in rubric order and flags Moderate or above', () => {
    const out = formatScores({ violence: 2, language: 0, frightening: 1 });
    expect(out).toEqual([
      { label: 'Language', value: 0, high: false },
      { label: 'Violence', value: 2, high: true },
      { label: 'Frightening', value: 1, high: false },
    ]);
    expect(formatScores(null)).toEqual([]);
  });
});
