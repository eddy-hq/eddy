// Shared helpers for the content module.

// Pure decision for whether a yt-dlp invocation should carry the guest-visitor
// cookie jar. Kept free of fs so it's unit-testable; the caller runs the
// fs.existsSync and passes `exists`.
//
// The jar is an aged, never-logged-in "guest visitor" identity, NOT an account
// login. YouTube appears to score fresh anonymous sessions per IP
// (yt-dlp #14899/#15865); an aged guest jar passes gates a fresh session fails
// (#15583). Empty path = feature off (fresh session per run, prior behaviour).
// Configured-but-missing (exists=false) is also feature-off for the run: a
// missing jar must never fail a download, so we return no flag and the caller
// warns.
export function guestCookieArgs(cookiePath: string, exists: boolean): string[] {
  if (cookiePath && exists) return ['--cookies', cookiePath];
  return [];
}
