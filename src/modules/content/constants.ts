// Drop YouTube Shorts at intake. Sub-90s clips break the model Eddy is
// built around: completion telemetry is meaningless, hooks ("max 15
// words, specific not generic") are longer than the video, and the 9:16
// format doesn't fit the 16:9 grid. Kids can still share individual
// shorts via the iOS Shortcut → guard path.
export const SHORTS_MAX_SECS = 90;
