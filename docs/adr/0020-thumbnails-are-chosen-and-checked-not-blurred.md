# Thumbnails are chosen and checked, never blurred or hot-linked

**Status:** Accepted and built for the feed's video cards. Not covered: the media server's poster image, and the parent-facing Decisions cards, which show the creator's thumbnail by choice.

A creator's thumbnail is the most clickbait surface on the platform: shocked faces, arrows, garish text. It is also imagery no guard has seen. The guard reads a video's words ([[0017-the-model-describes-code-decides]]); a kid's screen shows a picture. Two problems, then: the thumbnail may be ugly, and it may be unsafe.

The first idea was to neutralise every thumbnail with a filter: blur, desaturate, dim. It solves neither problem well. A blurred image reads as broken, and the editorial look the rest of Eddy aims for depends on good imagery, not muted imagery.

The rule: **every image a kid could see on a video card is chosen from real frames and checked against the rubric before it is shown. The bytes checked are the bytes served. If nothing passes, the card gets a neutral placeholder, never the creator's image.**

**The picker** runs on the fetch box after each download, in its own queue, reaching the inference box over signed internal calls ([[0001-one-box-moves-bytes-one-thinks]]). It tries, in order:

1. **The creator's thumbnail**, if the local model classes its composition as editorial rather than bait.
2. **The platform's auto-chosen frames**, the first classed editorial.
3. **Frames sampled from the downloaded file**, scored for composition; the best-composed one wins.
4. **A neutral placeholder**: a plain dark image inlined in the page, so it needs no file and can't go missing.

**The safety floor.** Every image the picker would show is first scored by the local vision model on three rubric dimensions (violence, frightening, sexual), 0 to 3. Any score above 1 rejects it and the picker moves on. A model error or an unparseable reply is a reject, never a pass, and the worker re-checks the scores itself rather than trusting a pass flag. Checks per video are capped; once they run out, the placeholder wins. The placeholder is also the interim image between download and the picker finishing.

**Never hot-linked.** Every winner, platform images included, is downloaded, checked, converted and served from home. Serving the platform's image URL would let a creator swap the picture after it passed. The PWA has no fallback to the creator's image: a card without a vetted thumbnail shows the placeholder background, for every user.

**Kid search shows no thumbnails.** Search results are raw platform results nobody has guarded. For a kid, search goes through the platform's strict safe-search only; when that isn't available (the scraping source has no safe-search control) a kid gets an empty list with a reason, not unfiltered results. Titles still show, and the kid can still ask for a video through the normal request path.

## Consequences

- **Some cards are plain.** A video whose candidates all fail, or whose checks run out, shows a dark rectangle. That is the intended outcome: a video whose best images are all over the floor is one to show neutrally.
- **Thumbnails cost inference.** Each check is a vision-model call on the box that also runs the guard. The cap keeps a busy day bounded.
- **The floor uses the rubric's anchors.** The same severity scale as the guard, applied to one still, so "frightening 2" means the same thing on a thumbnail as in a video.
- **Logs carry counts and scores only**: which slot won, how many checks ran and failed. No titles, no model reasons, which would describe the image ([[0004-kids-consumption-stays-home]]).
- **Thumbnails outlive recycled files**, so a recycled card stays recognisable.

## Considered and rejected

- **Blur, desaturate or dim every thumbnail.** Rejected: it looks broken, and it softens an unsafe image rather than refusing it.
- **Hot-link the platform's image.** Rejected: the image can change after it was checked.
- **Show the creator's thumbnail while the picker runs.** Rejected: it shows a kid unchecked imagery for exactly the window when the card is new.
- **Fail open on a scorer error.** Rejected: kid safety defaults to refusal. An error costs a nicer picture, nothing more.

## Deferred

- **The media server's poster.** It is still set to the creator's thumbnail at download and is not updated by the picker, so it is unchecked.
- **Parent surfaces.** The Decisions cards load the creator's thumbnail from the platform. They are parent-only, and the parent is judging the video, so this is deliberate, not an oversight.
