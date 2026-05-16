# People as the subscription unit

Every other media product organises around channels (YouTube), feeds (RSS), shows (podcasts), or topics (TikTok). Eddy's subscription unit is the **Person** — an individual creator, duo, or studio treated as a single identity across all their **Outputs** (YouTube channel, Substack, podcast, books, blog). Following a person subscribes to all of their outputs in one action; their **Recommendations** — pointers to things they didn't make — surface as **Candidates** with the recommender's name attached.

The decision rests on a bet about what's becoming scarce. As AI-generated content volume goes vertical, the scarce resource stops being content and starts being *trusted human judgement* (Section 1). Making the person the first-class concept — and the media types secondary — keeps the trust relationship visible at every surface and lets one subscription cover a creator's podcast, their books, their blog, and the things they've pointed at. Channels-as-unit would have shipped faster but would have collapsed trust into a content signal and made cross-media following a future bolt-on rather than the data model.

## Consequences

- Recommendation extraction from a followed person's text outputs is a first-class pipeline, not a future feature. The "no automated recommendation without a visible reason" rule routes through the person wherever possible — *"Tyler recommended this book twice in the last six months."*
- `persons` is the first-class entity; `outputs` are joined to it. A new content source for a person is a new row in `outputs`, not a new subscription.
- Person-level transparency on kid surfaces is qualitative and observational, never quantitative or ranked — see Section 4a and the no-surveillance rule in Section 1. The **Person view** is a reflective surface, not a discovery one.
- A `person_type` flag (individual, duo, group, studio) handles edge cases like Dude Perfect or family channels. Mechanics don't change with type; only the UI register may.
- For kids in v1, most followed people have a single output (their YouTube channel). The data model is uniform across ages; the UI complexity for kids is deliberately thin. As a kid grows into other media, the infrastructure is already there.
