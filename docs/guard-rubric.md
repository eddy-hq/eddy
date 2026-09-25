# Guard rubric — v1.2

The parent's standards the guard judges against. Models score the dimensions and detect hard stops and flags; the limits table decides the verdict. One versioned source read by the guard prompt, the offline teacher, parent reason chips, and any trained student (brief §9, Phase 6a, §22; ADR-0014). Every label records the rubric version it was made under.

Examples here are generic on purpose — never drawn from household viewing.

The guard reads this rubric as code from `src/modules/guard/rubric.ts` (`rubric-v1.2`); change both together — a test fails if the limits or flag tables diverge.

Scale per dimension: 0 None · 1 Mild · 2 Moderate · 3 Severe.

## Hard stops (yes/no — any yes → clear_no)

- Self-harm / suicide content (beyond respectful educational treatment)
- Hate targeting a group
- Any sexualisation of children (Elsagate-style)
- Manosphere / misogyny as a worldview (Tate-style; "alpha" content that tips into contempt for women). Fitness, discipline or study motivation without contempt is not a hard stop.

Hard stops fire only on clear evidence. Suspected but unclear → uncertain (escalate), never clear_yes; grey-area content is scored on the dimensions instead.

## Flags (facts, not scales — the limits table decides per band)

- Adult-rated game — gameplay or content from a PEGI 18 / ESRB M title (GTA, Call of Duty, …). Dimensions are still scored on what is actually shown; the flag lets bands treat 18-rated games differently.
- Loot-box / pack opening — pack or case openings with loot-box mechanics (EA FC Ultimate Team, etc.). Scored Commercial 2 on its own facts; the flag carries the parent's preference (see Flags under the limits table).

Detection is general-purpose (any parent would agree the flag applies); the action is the parent's, per kid. Flags are the mechanism for "things this parent specifically cares about".

## Dimensions

1. Language
   - 0 None — nothing a teacher would react to. "Oh my gosh", "oh my God", "what the heck", "rubbish".
   - 1 Mild — occasional mild swearing or bleeped strong words. "Bloody", "damn", "crap", "hell", toilet humour, a bleeped f-word.
   - 2 Moderate — regular mild swearing or occasional unbleeped strong swearing. A streamer swearing when losing, a couple of unbleeped f-words in a 20-minute video, crude insults between friends.
   - 3 Severe — frequent strong swearing or the worst words. F-word every sentence, the c-word, graphic sexual slang.
   - Rules: one slip in a long video scores a level lower than sustained use; bleeped scores a level lower; swearing aimed at someone (abuse) scores a level higher; context (football, gaming) doesn't change the score; slurs go to the hate hard stop or Attitude, not here.
   2. Violence
   - 0 None — no harm shown. Ordinary sport, cooking, science.
   - 1 Mild — stylised or cartoon, no blood. Slapstick, ordinary Minecraft/Fortnite fighting, hard football tackles, nature-doc hunts without close-ups.
   - 2 Moderate — realistic with some blood, or brief real fights. Realistic shooter gameplay, boxing/MMA knockouts, a brief real street-fight clip, war-documentary footage.
   - 3 Severe — gore, torture, real serious injury or death. Graphic horror kills, real accident or war casualties, animal cruelty, sustained real beatings.
   - Rules: real scores a level higher than equivalent fiction; glorified or gratuitous (fight compilations set to music, "most brutal knockouts") scores a level higher; educational framing doesn't lower the score but is noted in the reason; realistic real-world weapons (modern firearms shown as real guns) score at least 2, even inside a stylised game; torture or cruelty as the premise scores at least 2, even when stylised or played for laughs.
3. Frightening / intense
   - 0 None — nothing unsettling.
   - 1 Mild — spooky for fun, played light. Halloween content, cartoon monsters, a Minecraft horror map played for laughs, "creepy facts" told cheerfully.
   - 2 Moderate — real tension and jump scares, meant to scare. Straight horror-game playthroughs (FNAF, Poppy Playtime — kid-targeted horror is still horror), creepypasta and analog horror, unsolved mysteries, disaster footage without casualties, restrained true crime (narrated case, real victims, no graphic detail).
   - 3 Severe — designed to disturb, or real people in real danger or death. Graphic horror, true crime that dwells on victims or graphic detail, real accident or death footage, people in genuine peril.
   - Rules: real scores a level higher than fiction (restrained true crime is the named exception, anchored at 2); sustained scores a level higher than brief — one jump scare in a funny video stays at 1; shock-bait titles or thumbnails are noted in the reason even when the content is tamer.
4. Sexual content
   - 0 None — nothing sexual.
   - 1 Mild — romance or innuendo that goes over most kids' heads. Kissing, a crush storyline, a passing double entendre, swimwear in a normal context (beach vlog, swimming).
   - 2 Moderate — overt sexual jokes or suggestiveness as the focus. Repeated sexual jokes, thirst-trap framing, suggestive dancing or outfits as the point of the video, frank talk about sex without explicit detail.
   - 3 Severe — nudity or explicit sexual content. Nudity, sexual acts shown or described in detail, fetish content.
   - Rules: clearly educational sex/puberty content is capped at 1 whatever the topic (the one place framing lowers a score); "rizz", dating-influencer and rating-girls content scores under Attitude, not here — only explicit sexual talk scores here; sexualisation of children is a hard stop, never a score.
5. Substances
   - 0 None — nothing.
   - 1 Mild — incidental, background, or educational. Adults with a pint in a football vlog, a film character smoking, drug-awareness content.
   - 2 Moderate — use shown as the subject, or casually glamorised. A creator vaping on camera, "getting drunk" stories told as funny, drinking games in a vlog.
   - 3 Severe — drug use shown or taught, or substance culture celebrated. Drug use on camera, how to obtain, vape-trick tutorials, heavy drinking as the point.
   - Rules: glamorised scores a level higher; a creator using on camera weighs more than a depiction; clearly educational awareness content is capped at 1. Energy drinks are not substances — brand hype scores under Commercial pressure, caffeine challenges under Dangerous acts.
6. Dangerous acts
   - Test: how easily could a 12-year-old copy it with what's at home or outside?
   - 0 None — nothing risky.
   - 1 Mild — risk handled by professionals, or low stakes. Pro parkour or extreme sports, science demos with safety framing, knife skills in cooking.
   - 2 Moderate — copyable amateur risk, minor harm likely. Amateur trampoline or skate stunts, spicy-food and caffeine challenges, physical pranks, urban exploring, fail compilations.
   - 3 Severe — copyable with serious harm possible. Viral challenges (blackout, fire, chroming), rooftopping, train surfing, car stunts on public roads, weapons, explosives, homemade pyrotechnics.
   - Rules: framed as an invitation ("try this", "challenge your mates") scores a level higher; harm shown without consequence (injury as punchline) scores a level higher — fail compilations are anchored at 2 on this basis; a professional setting with visible safety anchors at 1 however extreme the stunt.
7. Commercial pressure
   - 0 None — nothing being sold. Incidental betting branding in football (shirt sponsors, pitch boards, a half-time ad) scores 0 — unavoidable in UK football.
   - 1 Mild — standard disclosed ads and reviews. A labelled sponsor read, honest reviews, "link in description".
   - 2 Moderate — selling woven into the content, or aimed at kids. Undisclosed or blended sponsorship, merch pushed at young fans, energy-drink brand hype, haul flexing, loot-box / pack openings presented as exciting.
   - 3 Severe — gambling, gambling-like mechanics, or get-rich schemes. Real-money case openings or skin gambling, casino or slots streams, a creator promoting betting, crypto or trading "hustle", "free V-Bucks/Robux" scams.
   - Rules: pitched directly at kids ("ask your parents", "use my code") scores a level higher; undisclosed scores a level higher.
8. Attitude
   - 0 None — neutral or positive.
   - 1 Mild — edgy but good-natured. Roast humour between willing friends, cheeky rudeness, harmless pranks where everyone's laughing.
   - 2 Moderate — cruelty or contempt as entertainment. Pranks where someone's distress is the point, "rizz" and rating-girls content, mocking a group (short of hate), wealth-flexing as aspiration, conspiracy-lite.
   - 3 Severe — an ideology, or a real target. Bullying a real identifiable person, dehumanising humour about a group, glamorised gang or crime culture. (Manosphere worldview is a hard stop, not a 3.)
   - Rules: presented as advice or worldview ("this is how men should…") scores a level higher than a one-off joke; a real identifiable target scores a level higher than fiction or a willing participant.
   - Level 2 here is the content most to avoid — the strictest dimension in the limits table. Titles often hide it; a borderline Attitude score is a reason to fetch the transcript on the second pass.

## Limits table

Per age band, not per kid — a younger sibling reaching a band gets exactly what the older one had. Values are the maximum allowed score.

| Dimension | Under 10 (default for unknown age) | 10–12 | 13–15 |
|---|---|---|---|
| Language | 1 | 2 | 2 |
| Violence | 1 | 1 | 2 |
| Frightening | 1 | 1 | 2 |
| Sexual | 0 | 1 | 1 |
| Substances | 0 | 1 | 1 |
| Dangerous acts | 1 | 1 | 2 |
| Commercial | 1 | 1 | 2 |
| Attitude | 1 | 1 | 1 |

16–17 and 18+ are not yet set; until they are, those bands use 13–15.

### Verdict mapping

- Any hard stop → **clear_no**.
- Every dimension within its limit → **clear_yes**.
- One or more dimensions over by exactly one level → **uncertain** (a request escalates; a discovery candidate doesn't surface, since discovery requires clear_yes).
- Any dimension over by two or more → **clear_no**.
- Then flags apply.

Discovery is stricter than requests by construction: it surfaces only clear_yes, where a request's uncertain reaches a parent.

### Flags

| Flag | Under 10 | 10–12 | 13–15 |
|---|---|---|---|
| Adult-rated game | Request: escalate · Discovery: never | Request: escalate · Discovery: never | Request: allow (scored on content) · Discovery: never |
| Loot-box / pack opening | Request: escalate · Discovery: never | Request: allow · Discovery: never | Request: allow · Discovery: never |

A flag's request action can only make a verdict stricter (allow leaves the dimension verdict as is), never looser.

## Thumbnails (applies across dimensions)

- The creator's thumbnail is evidence for scoring content: note a suggestive or shock-bait creator thumbnail in the reason as a sign the content leans that way. Score the content, not the thumbnail.
- It can also be exposure. After download the thumbnail picker (brief §6) may keep an editorial creator thumbnail, but only once it has passed the same safety floor as any frame — so where it's shown, it has been checked.
- Frame picker safety floor (6a, `thumb-safety-v1`): every image the picker would show — creator thumbnail, YouTube auto-frame or sampled frame — must score 0–1 on Violence, Frightening and Sexual, using the anchors above as they apply to a still image, or it's rejected. A scorer failure is a reject. If nothing passes, a neutral placeholder is shown, never the creator image.
- Not covered by the floor: surfaces that render thumbnails before download (search, Person pages, discovery previews) — handled by the companion exposure fixes — and the Plex poster, which is still the creator thumbnail.
- The former open question (do kids see unchecked creator thumbnails?) is resolved by the floor (#209) for downloaded videos and by the companion exposure fixes for pre-download surfaces.
