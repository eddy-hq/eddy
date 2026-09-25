import { describe, expect, it } from 'vitest';
import {
  EMPTY_REASON,
  agreement,
  blockChannelBody,
  blockChannelFlash,
  blockChannelPrompt,
  blockChannelSubjects,
  canBlockChannel,
  decisionsForCard,
  formatScores,
  hasReason,
  keyAction,
  reasonFields,
  reasonSummary,
  removeChannelCards,
  removeDecided,
  setReasonText,
  skipCard,
  toggleReasonDimension,
  type BlockChannelResult,
  type ReasonOptions,
  type CardSubject,
  type DecisionCard,
} from './decisions';

function subject(id: string, userId: string): CardSubject {
  return { subjectType: 'candidate', subjectId: id, userId, kidName: userId, ageBand: '10-12', guard: null };
}

function card(
  key: string,
  subjects: CardSubject[],
  channel: { channel?: string | null; channelId?: string | null } = {},
): DecisionCard {
  return {
    key, source: 'escalation', url: `https://example.test/${key}`, youtubeId: key, title: key,
    channel: channel.channel ?? null, channelId: channel.channelId ?? null,
    description: '', thumbnailUrl: null, addedAt: '2026-09-25T00:00:00.000Z', subjects,
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

describe('Block channel', () => {
  const CHANNEL_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
  const CHANNEL_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

  it('is offered only when the card knows its channel id', () => {
    expect(canBlockChannel(card('v1', [subject('s1', 'kid1')], { channel: 'Placeholder channel', channelId: CHANNEL_A }))).toBe(true);
    expect(canBlockChannel(card('v2', [subject('s2', 'kid1')], { channel: 'Placeholder channel' }))).toBe(false);
  });

  it('names the channel in the confirm step', () => {
    expect(blockChannelPrompt(card('v1', [], { channel: 'Placeholder channel', channelId: CHANNEL_A })))
      .toBe('Block Placeholder channel for every kid?');
    expect(blockChannelPrompt(card('v1', [], { channelId: CHANNEL_A }))).toBe('Block this channel for every kid?');
  });

  it('sends every kid on the card', () => {
    const both = card('v1', [subject('s1', 'kid1'), subject('s2', 'kid2')], { channelId: CHANNEL_A });
    expect(blockChannelSubjects(both)).toEqual([
      { subjectType: 'candidate', subjectId: 's1' },
      { subjectType: 'candidate', subjectId: 's2' },
    ]);
  });

  it("drops the channel's other cards, by id or by name when the id is unknown", () => {
    const cards = [
      card('v1', [subject('s1', 'kid1')], { channel: 'Placeholder channel', channelId: CHANNEL_A }),
      card('v2', [subject('s2', 'kid1')], { channel: 'Placeholder channel', channelId: CHANNEL_A }),
      card('v3', [subject('s3', 'kid2')], { channel: 'Placeholder channel' }),
      card('v4', [subject('s4', 'kid2')], { channel: 'Other placeholder', channelId: CHANNEL_B }),
      card('v5', [subject('s5', 'kid2')], { channel: 'Placeholder channel', channelId: CHANNEL_B }),
      card('v6', [subject('s6', 'kid1')]),
    ];
    const left = removeChannelCards(cards, { channelId: CHANNEL_A, displayName: 'Placeholder channel' });
    // v5 shares the name but has a different id: it stays.
    expect(left.map((c) => c.key)).toEqual(['v4', 'v5', 'v6']);
  });

  it('flashes what the block did', () => {
    const result = (n: number, alreadyBlocked = false): BlockChannelResult => ({
      channel: { channelId: CHANNEL_A, displayName: 'Placeholder channel' },
      alreadyBlocked, poolRowsRemoved: n, outcomes: [],
    });
    expect(blockChannelFlash(result(0))).toBe('Blocked Placeholder channel · nothing else queued');
    expect(blockChannelFlash(result(1))).toBe('Blocked Placeholder channel · 1 queued video removed');
    expect(blockChannelFlash(result(3, true))).toBe('Already blocked Placeholder channel · 3 queued videos removed');
  });
});

// ── Reason chips ─────────────────────────────────────────────────────────────

const OPTIONS: ReasonOptions = {
  dimensions: [
    { key: 'language', label: 'Language' },
    { key: 'violence', label: 'Violence' },
    { key: 'frightening', label: 'Frightening' },
  ],
  textMax: 10,
};

describe('toggleReasonDimension', () => {
  it('selects and deselects a chip', () => {
    const on = toggleReasonDimension(EMPTY_REASON, 'violence', OPTIONS);
    expect(on.dimensions).toEqual(['violence']);
    expect(toggleReasonDimension(on, 'violence', OPTIONS).dimensions).toEqual([]);
  });

  it('keeps selected chips in rubric order whatever the tap order', () => {
    let draft = toggleReasonDimension(EMPTY_REASON, 'frightening', OPTIONS);
    draft = toggleReasonDimension(draft, 'language', OPTIONS);
    expect(draft.dimensions).toEqual(['language', 'frightening']);
  });

  it('ignores a key that is not on offer', () => {
    expect(toggleReasonDimension(EMPTY_REASON, 'gore', OPTIONS)).toBe(EMPTY_REASON);
  });

  it('leaves the note alone', () => {
    const draft = toggleReasonDimension({ dimensions: [], text: 'hi' }, 'language', OPTIONS);
    expect(draft.text).toBe('hi');
  });
});

describe('setReasonText', () => {
  it("cuts the note to the server's cap", () => {
    expect(setReasonText(EMPTY_REASON, 'x'.repeat(25), OPTIONS).text).toBe('x'.repeat(10));
  });
});

describe('reasonFields and hasReason', () => {
  it('leaves both fields out when nothing is picked', () => {
    expect(reasonFields(EMPTY_REASON)).toEqual({});
    expect(reasonFields({ dimensions: [], text: '   ' })).toEqual({});
    expect(hasReason({ dimensions: [], text: '   ' })).toBe(false);
  });

  it('carries chips and a trimmed note', () => {
    const draft = { dimensions: ['violence'], text: '  scary  ' };
    expect(reasonFields(draft)).toEqual({ reasonDimensions: ['violence'], reasonText: 'scary' });
    expect(hasReason(draft)).toBe(true);
  });
});

describe('reasonSummary', () => {
  it('is null with nothing picked, else the chip labels and "note"', () => {
    expect(reasonSummary(EMPTY_REASON, OPTIONS)).toBeNull();
    expect(reasonSummary({ dimensions: ['language', 'violence'], text: '' }, OPTIONS)).toBe('Language, Violence');
    expect(reasonSummary({ dimensions: ['violence'], text: 'x' }, OPTIONS)).toBe('Violence, note');
  });
});

describe('decision payloads with a reason', () => {
  const both = card('v1', [subject('s1', 'kid1'), subject('s2', 'kid2')], { channel: 'Placeholder', channelId: 'UC1' });
  const reason = { dimensions: ['frightening'], text: 'Too scary' };

  it('puts the reason on every kid for "same for both"', () => {
    expect(decisionsForCard(both, 'clear_no', undefined, reason)).toEqual([
      { subjectType: 'candidate', subjectId: 's1', verdict: 'clear_no', reasonDimensions: ['frightening'], reasonText: 'Too scary' },
      { subjectType: 'candidate', subjectId: 's2', verdict: 'clear_no', reasonDimensions: ['frightening'], reasonText: 'Too scary' },
    ]);
  });

  it('puts the reason on the one kid decided', () => {
    expect(decisionsForCard(both, 'clear_yes', 'kid1', { dimensions: [], text: 'ok' })).toEqual([
      { subjectType: 'candidate', subjectId: 's1', verdict: 'clear_yes', reasonText: 'ok' },
    ]);
  });

  it('a bare decision posts no reason fields', () => {
    expect(decisionsForCard(both, 'clear_yes', 'kid2', EMPTY_REASON)).toEqual([
      { subjectType: 'candidate', subjectId: 's2', verdict: 'clear_yes' },
    ]);
  });

  it('Block channel carries every kid and the reason', () => {
    expect(blockChannelBody('parent', both, reason)).toEqual({
      userId: 'parent',
      subjects: [{ subjectType: 'candidate', subjectId: 's1' }, { subjectType: 'candidate', subjectId: 's2' }],
      reasonDimensions: ['frightening'],
      reasonText: 'Too scary',
    });
    expect(blockChannelBody('parent', both)).toEqual({
      userId: 'parent',
      subjects: [{ subjectType: 'candidate', subjectId: 's1' }, { subjectType: 'candidate', subjectId: 's2' }],
    });
  });
});
