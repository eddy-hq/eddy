// Public barrel for the people module. After the #86 split, all logic lives
// in leaf files (`registry`, `poller`, `router`, `personView`, `util`, etc.)
// and this file only re-exports their public surface. Siblings import from
// here; `requests/state.ts` is the one sanctioned deep-import (into
// `./registry`) to break the requests↔people runtime cycle.
export { applyChannelInfoToPerson, ensurePersonForChannel } from './registry';
export { extractBio } from './util';
export { getPersonView, parseSupportUrls, isKidVisibleSupport } from './personView';
export type {
  PersonView,
  PersonViewItem,
  PersonViewPerson,
  PersonViewSupport,
  SupportKind,
} from './personView';
export { startRssPoller, stopRssPoller } from './poller';
export { peopleRouter } from './router';
