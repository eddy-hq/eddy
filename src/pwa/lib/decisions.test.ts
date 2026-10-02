import { describe, expect, it } from 'vitest';
import {
  ANSWER_KEY,
  EMPTY_REASON,
  agreement,
  answerButtonLabel,
  answerFields,
  answerLabel,
  answerVerdict,
  blockChannelBody,
  blockChannelFlash,
  blockChannelPrompt,
  blockChannelSubjects,
  canBlockChannel,
  decisionsForCard,
  formatScores,
  guardInputRows,
  guardInputsParams,
  type GuardInputs,
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
  changeOptions,
  freshReviewList,
  isKindOnlyChange,
  isDisagreement,
  isFilterSwitch,
  mergeReviewPage,
  reviseInList,
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
    expect(decisionsForCard(both, 'unsafe')).toEqual([
      { subjectType: 'candidate', subjectId: 's1', verdict: 'clear_no', blockKind: 'unsafe' },
      { subjectType: 'candidate', subjectId: 's2', verdict: 'clear_no', blockKind: 'unsafe' },
    ]);
  });

  it('decides one kid when named', () => {
    expect(decisionsForCard(both, 'allow', 'kid2')).toEqual([
      { subjectType: 'candidate', subjectId: 's2', verdict: 'clear_yes' },
    ]);
  });

  it('sends Not for us as a Block with its kind', () => {
    expect(decisionsForCard(both, 'not_for_us', 'kid1')).toEqual([
      { subjectType: 'candidate', subjectId: 's1', verdict: 'clear_no', blockKind: 'not_for_us' },
    ]);
  });
});

describe('answers (#227)', () => {
  it('sends Unsafe and Not for us as clear_no with a kind, and Allow with none', () => {
    expect(answerFields('allow')).toEqual({ verdict: 'clear_yes' });
    expect(answerFields('unsafe')).toEqual({ verdict: 'clear_no', blockKind: 'unsafe' });
    expect(answerFields('not_for_us')).toEqual({ verdict: 'clear_no', blockKind: 'not_for_us' });
    expect(answerVerdict('unsafe')).toBe('clear_no');
    expect(answerVerdict('not_for_us')).toBe('clear_no');
    expect(answerVerdict('allow')).toBe('clear_yes');
  });

  it('words a stored answer, keeping an unrecorded Block as "block"', () => {
    expect(answerLabel('clear_yes', null)).toBe('allow');
    expect(answerLabel('clear_no', 'unsafe')).toBe('unsafe');
    expect(answerLabel('clear_no', 'not_for_us')).toBe('not for us');
    expect(answerLabel('clear_no', null)).toBe('block');
  });

  it('labels the buttons, for one kid or both', () => {
    expect(answerButtonLabel('unsafe', false)).toBe('Unsafe');
    expect(answerButtonLabel('not_for_us', true)).toBe('Not for us · both');
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
  it('maps a, u, f and s when deciding', () => {
    expect(keyAction('a', false)).toBe('allow');
    expect(keyAction('U', false)).toBe('unsafe');
    expect(keyAction('f', false)).toBe('not_for_us');
    expect(keyAction('s', false)).toBe('skip');
    expect(keyAction('Enter', false)).toBeNull();
    // No plain Block, and "n" (next) never decides a card.
    expect(keyAction('b', false)).toBeNull();
    expect(keyAction('n', false)).toBeNull();
    expect(Object.values(ANSWER_KEY)).toEqual(['A', 'U', 'F']);
  });

  it('only continues while a reveal is showing', () => {
    expect(keyAction('a', true)).toBeNull();
    expect(keyAction('u', true)).toBeNull();
    expect(keyAction('f', true)).toBeNull();
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
    expect(decisionsForCard(both, 'unsafe', undefined, reason)).toEqual([
      { subjectType: 'candidate', subjectId: 's1', verdict: 'clear_no', blockKind: 'unsafe', reasonDimensions: ['frightening'], reasonText: 'Too scary' },
      { subjectType: 'candidate', subjectId: 's2', verdict: 'clear_no', blockKind: 'unsafe', reasonDimensions: ['frightening'], reasonText: 'Too scary' },
    ]);
  });

  it('puts the reason on the one kid decided', () => {
    expect(decisionsForCard(both, 'allow', 'kid1', { dimensions: [], text: 'ok' })).toEqual([
      { subjectType: 'candidate', subjectId: 's1', verdict: 'clear_yes', reasonText: 'ok' },
    ]);
  });

  it('a bare decision posts no reason fields', () => {
    expect(decisionsForCard(both, 'allow', 'kid2', EMPTY_REASON)).toEqual([
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

  it('treats either Block kind as a Block under Disagreements', () => {
    const unsafe = reviewCard('u', { guardVerdict: 'clear_yes', firstVerdict: 'clear_no', firstBlockKind: 'unsafe', verdict: 'clear_no', blockKind: 'unsafe' });
    const notForUs = reviewCard('n', { guardVerdict: 'clear_yes', firstVerdict: 'clear_no', firstBlockKind: 'not_for_us', verdict: 'clear_no', blockKind: 'not_for_us' });
    const agreedNotForUs = reviewCard('g', { guardVerdict: 'clear_no', firstVerdict: 'clear_no', verdict: 'clear_no', blockKind: 'not_for_us' });
    expect([unsafe, notForUs, agreedNotForUs]
      .filter((c) => matchesReviewFilter(c, 'disagreements')).map((c) => c.key)).toEqual(['u', 'n']);
  });

  it('offers every answer but the current one', () => {
    expect(changeOptions(reviewCard('a', { verdict: 'clear_yes' }))).toEqual(['unsafe', 'not_for_us']);
    // A Block with no recorded kind can be given either kind.
    expect(changeOptions(reviewCard('b', { verdict: 'clear_no', blockKind: null }))).toEqual(['allow', 'unsafe', 'not_for_us']);
    expect(changeOptions(reviewCard('b'))).toEqual(['allow', 'unsafe', 'not_for_us']);
    expect(changeOptions(reviewCard('u', { verdict: 'clear_no', blockKind: 'unsafe' }))).toEqual(['allow', 'not_for_us']);
    expect(changeOptions(reviewCard('n', { verdict: 'clear_no', blockKind: 'not_for_us' }))).toEqual(['allow', 'unsafe']);
    expect(changeLabel('allow')).toBe('Change to Allow');
    expect(changeLabel('unsafe')).toBe('Change to Unsafe');
    expect(changeLabel('not_for_us')).toBe('Change to Not for us');
  });

  it('knows a kind on a current Block is a kind-only change', () => {
    expect(isKindOnlyChange(reviewCard('b'), 'unsafe')).toBe(true);
    expect(isKindOnlyChange(reviewCard('b'), 'allow')).toBe(false);
    expect(isKindOnlyChange(reviewCard('a', { verdict: 'clear_yes' }), 'not_for_us')).toBe(false);
  });

  it('builds the revision request with the answer and the optional reason', () => {
    const c = reviewCard('d1', { verdict: 'clear_yes' });
    expect(revisionBody('parent', c, 'unsafe')).toEqual({ userId: 'parent', decisionId: 'd1', verdict: 'clear_no', blockKind: 'unsafe' });
    expect(revisionBody('parent', c, 'not_for_us', { dimensions: ['violence'], text: ' Note ' })).toEqual({
      userId: 'parent', decisionId: 'd1', verdict: 'clear_no', blockKind: 'not_for_us', reasonDimensions: ['violence'], reasonText: 'Note',
    });
    expect(revisionBody('parent', reviewCard('d2'), 'allow')).toEqual({ userId: 'parent', decisionId: 'd2', verdict: 'clear_yes' });
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
    expect(answerLine(reviewCard('a', {
      firstBlockKind: null, blockKind: 'not_for_us',
      revision: { revisedAt: '2026-09-26T00:00:00.000Z', effect: 'label_only', count: 1 },
    }).decision)).toBe('You said block, now not for us');
    expect(answerLine(reviewCard('a', { firstBlockKind: 'unsafe', blockKind: 'unsafe' }).decision)).toBe('You said unsafe');
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

  it('treats re-selecting the current filter as no switch', () => {
    expect(isFilterSwitch('disagreements', 'disagreements')).toBe(false);
    expect(isFilterSwitch('all', 'all')).toBe(false);
    expect(isFilterSwitch('disagreements', 'all')).toBe(true);
  });

  it('drops a late page asked for by a list that has since been reloaded', () => {
    const page = (filter: 'disagreements' | 'all', keys: string[], nextOffset: number | null) => ({
      filter, cards: keys.map((k) => reviewCard(k)), reasons: opts, counts: { disagreements: 0, all: 0 }, nextOffset,
    });
    const all = freshReviewList(null, page('all', ['a', 'b'], 2));
    const askedFor = all.loadId;
    // The parent switches to Disagreements before "Show more" on All returns.
    const disagreements = freshReviewList(all, page('disagreements', ['x'], 1));
    const late = mergeReviewPage(disagreements, askedFor, page('all', ['c'], 4));
    expect(late).toBe(disagreements);
    // Switching back to All reloads it too: the old page still doesn't land.
    const allAgain = freshReviewList(disagreements, page('all', ['a', 'b'], 2));
    expect(mergeReviewPage(allAgain, askedFor, page('all', ['c'], 4))).toBe(allAgain);
    // A page for the list on screen lands.
    const merged = mergeReviewPage(allAgain, allAgain.loadId, page('all', ['b', 'c'], null));
    expect(merged.cards.map((c) => c.key)).toEqual(['a', 'b', 'c']);
    expect(merged.nextOffset).toBeNull();
  });

  it('steps the offset back when a loaded card leaves the filter, so the next page skips nothing', () => {
    const cards = ['a', 'b', 'c'].map((k) => reviewCard(k));
    const list = freshReviewList(null, {
      filter: 'disagreements', cards, reasons: opts, counts: { disagreements: 4, all: 4 }, nextOffset: 3,
    });
    const agreeing = reviewCard('b', { guardVerdict: 'clear_no', firstVerdict: 'clear_no', verdict: 'clear_no' });
    const after = reviseInList(list, agreeing);
    expect(after.cards.map((c) => c.key)).toEqual(['a', 'c']);
    expect(after.nextOffset).toBe(2);
    // A page asked for at the old offset no longer lands.
    expect(mergeReviewPage(after, list.loadId, { cards: [reviewCard('e')], nextOffset: null })).toBe(after);

    // A card that stays keeps the offset and the pages in flight.
    const staying = reviewCard('b', {
      verdict: 'clear_yes', revision: { revisedAt: '2026-09-26T00:00:00.000Z', effect: 'eligible', count: 1 },
    });
    const kept = reviseInList(list, staying);
    expect(kept).toMatchObject({ loadId: list.loadId, nextOffset: 3 });
    expect(kept.cards.map((c) => c.decision.verdict)).toEqual(['clear_no', 'clear_yes', 'clear_no']);
  });

  it('appends a page without repeating cards already shown', () => {
    expect(appendReviewPage([reviewCard('a'), reviewCard('b')], [reviewCard('b'), reviewCard('c')]).map((c) => c.key))
      .toEqual(['a', 'b', 'c']);
  });
});

describe('What the guard saw (#225)', () => {
  const bare: GuardInputs = {
    promptVersion: null, transcript: null, tags: null, category: null,
    madeForKids: null, metadataSent: null, channelHistory: null,
  };

  it('asks about a Review card by decision and a queue card by subject', () => {
    const s = subject('s1', 'kid1');
    expect(guardInputsParams('p1', s, 'd1').toString()).toBe('userId=p1&decisionId=d1');
    expect(guardInputsParams('p1', s).toString()).toBe('userId=p1&subjectType=candidate&subjectId=s1');
  });

  it('lists every stored input, the transcript excerpt as a block', () => {
    const rows = guardInputRows({
      promptVersion: 'candidate-transcript-v4.1',
      transcript: { kind: 'excerpt', text: 'Placeholder excerpt' },
      tags: 'tag one, tag two',
      category: 'Gaming',
      madeForKids: false,
      metadataSent: null,
      channelHistory: { approved: 2, rejected: 1 },
    });
    expect(rows).toEqual([
      { label: 'Category', value: 'Gaming' },
      { label: 'Tags', value: 'tag one, tag two' },
      { label: 'YouTube audience', value: 'Not made for kids' },
      { label: 'Channel history (now)', value: '2 approved, 1 rejected' },
      { label: 'Transcript excerpt', value: 'Placeholder excerpt', block: true },
      { label: 'Prompt', value: 'candidate-transcript-v4.1' },
    ]);
  });

  it('says plainly when the guard had no transcript', () => {
    expect(guardInputRows({ ...bare, transcript: { kind: 'none' } }))
      .toEqual([{ label: 'Transcript', value: 'The guard had no transcript' }]);
  });

  it('leaves out what is not stored, and an excerpt it cannot vouch for', () => {
    expect(guardInputRows(bare)).toEqual([]);
  });

  it('labels an empty channel history', () => {
    expect(guardInputRows({ ...bare, channelHistory: { approved: 0, rejected: 0 } }))
      .toEqual([{ label: 'Channel history (now)', value: 'No requests from this channel' }]);
  });

  it('marks metadata the judging prompt was not sent', () => {
    const rows = guardInputRows({ ...bare, tags: 'tag one', madeForKids: true, metadataSent: false });
    expect(rows).toEqual([
      { label: 'Tags', value: 'tag one', notSent: true },
      { label: 'YouTube audience', value: 'Made for kids', notSent: true },
    ]);
  });
});
