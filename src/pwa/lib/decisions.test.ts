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
  answerLine,
  appendReviewPage,
  applyRevision,
  changeLabel,
  changeTarget,
  isDisagreement,
  matchesReviewFilter,
  revisionBody,
  revisionEffectLabel,
  storedReasonSummary,
  type BlockChannelResult,
  type ReasonOptions,
  type CardSubject,
  type DecisionCard,
  type ReviewCard,
  type ReviewDecision,
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

describe('Review', () => {
  function reviewCard(key: string, decision: Partial<ReviewDecision> = {}): ReviewCard {
    return {
      ...card(key, [subject(`s-${key}`, 'kid1')]),
      source: 'spot_check',
      decision: {
        decisionId: key, decidedAt: '2026-09-25T00:00:00.000Z', guardVerdict: 'clear_yes',
        firstVerdict: 'clear_no', firstReason: null, verdict: 'clear_no', reason: null, revision: null,
        ...decision,
      },
    };
  }

  const opts: ReasonOptions = {
    dimensions: [{ key: 'violence', label: 'Violence' }, { key: 'frightening', label: 'Frightening' }],
    textMax: 280,
  };

  it('a disagreement needs a clear guard verdict opposite the answer', () => {
    expect(isDisagreement('clear_yes', 'clear_no')).toBe(true);
    expect(isDisagreement('clear_no', 'clear_yes')).toBe(true);
    expect(isDisagreement('clear_yes', 'clear_yes')).toBe(false);
    expect(isDisagreement('uncertain', 'clear_no')).toBe(false);
    expect(isDisagreement(null, 'clear_yes')).toBe(false);
  });

  it('filters on the first answer or the current one', () => {
    const agreed = reviewCard('a', { guardVerdict: 'clear_no', firstVerdict: 'clear_no', verdict: 'clear_no' });
    const escalation = reviewCard('e', { guardVerdict: 'uncertain', firstVerdict: 'clear_yes', verdict: 'clear_yes' });
    const revisedIntoAgreement = reviewCard('r', { guardVerdict: 'clear_yes', firstVerdict: 'clear_no', verdict: 'clear_yes' });
    const revisedOutOfAgreement = reviewCard('o', { guardVerdict: 'clear_yes', firstVerdict: 'clear_yes', verdict: 'clear_no' });
    expect([agreed, escalation, revisedIntoAgreement, revisedOutOfAgreement]
      .filter((c) => matchesReviewFilter(c, 'disagreements')).map((c) => c.key)).toEqual(['r', 'o']);
    expect([agreed, escalation].every((c) => matchesReviewFilter(c, 'all'))).toBe(true);
  });

  it('offers the opposite of the current answer', () => {
    expect(changeTarget(reviewCard('b', { verdict: 'clear_no' }))).toBe('clear_yes');
    expect(changeLabel(reviewCard('b', { verdict: 'clear_no' }))).toBe('Change to Allow');
    expect(changeLabel(reviewCard('a', { verdict: 'clear_yes' }))).toBe('Change to Block');
  });

  it('builds the revision request with the optional reason', () => {
    const c = reviewCard('d1', { verdict: 'clear_yes' });
    expect(revisionBody('parent', c)).toEqual({ userId: 'parent', decisionId: 'd1', verdict: 'clear_no' });
    expect(revisionBody('parent', c, { dimensions: ['violence'], text: ' Note ' })).toEqual({
      userId: 'parent', decisionId: 'd1', verdict: 'clear_no', reasonDimensions: ['violence'], reasonText: 'Note',
    });
  });

  it('labels every effect, and says plainly when nothing live changed', () => {
    expect(revisionEffectLabel('removed')).toBe('Removed from the feed');
    expect(revisionEffectLabel('blocked')).toBe('Taken out of the pool');
    expect(revisionEffectLabel('eligible')).toBe('Can be picked for a future slate');
    expect(revisionEffectLabel('label_only')).toMatch(/nothing live changed/);
  });

  it('shows the first answer, and the current one once revised', () => {
    expect(answerLine(reviewCard('a').decision)).toBe('You said block');
    expect(answerLine(reviewCard('a', {
      verdict: 'clear_yes', revision: { revisedAt: '2026-09-26T00:00:00.000Z', effect: 'label_only', count: 1 },
    }).decision)).toBe('You said block, now allow');
  });

  it('summarises a recorded reason', () => {
    expect(storedReasonSummary(null, opts)).toBeNull();
    expect(storedReasonSummary({ dimensions: [], text: null }, opts)).toBeNull();
    expect(storedReasonSummary({ dimensions: ['violence', 'unknown'], text: 'Note' }, opts)).toBe('Violence, unknown, "Note"');
  });

  it('replaces a changed card in place and drops it only when it leaves the filter', () => {
    const cards = [reviewCard('a'), reviewCard('b'), reviewCard('c')];
    const changed = reviewCard('b', {
      verdict: 'clear_yes', revision: { revisedAt: '2026-09-26T00:00:00.000Z', effect: 'eligible', count: 1 },
    });
    expect(applyRevision(cards, changed, 'disagreements').map((c) => [c.key, c.decision.verdict]))
      .toEqual([['a', 'clear_no'], ['b', 'clear_yes'], ['c', 'clear_no']]);
    const agreeing = reviewCard('b', { guardVerdict: 'clear_no', firstVerdict: 'clear_no', verdict: 'clear_no' });
    expect(applyRevision(cards, agreeing, 'disagreements').map((c) => c.key)).toEqual(['a', 'c']);
    expect(applyRevision(cards, agreeing, 'all').map((c) => c.key)).toEqual(['a', 'b', 'c']);
  });

  it('appends a page without repeating cards already shown', () => {
    expect(appendReviewPage([reviewCard('a'), reviewCard('b')], [reviewCard('b'), reviewCard('c')]).map((c) => c.key))
      .toEqual(['a', 'b', 'c']);
  });
});
