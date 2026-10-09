// Whether a path under /requests reaches the parent-only admin routes. Express
// matches routes case-insensitively, so this must too: a case-sensitive check
// would let `/requests/ADMIN/pipeline` reach an admin handler past the kid gate.
export function isAdminPath(path: string): boolean {
  return /^\/admin(?:\/|$)/i.test(path);
}
