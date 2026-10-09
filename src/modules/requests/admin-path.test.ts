import { describe, it, expect } from 'vitest';
import { isAdminPath } from './admin-path';

describe('isAdminPath', () => {
  it('matches the admin routes whatever their case', () => {
    expect(isAdminPath('/admin/pipeline')).toBe(true);
    expect(isAdminPath('/ADMIN/pipeline')).toBe(true);
    expect(isAdminPath('/Admin/abc/retry')).toBe(true);
    expect(isAdminPath('/admin')).toBe(true);
  });

  it('leaves the household routes alone', () => {
    expect(isAdminPath('/feed')).toBe(false);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/abc/admin/x')).toBe(false);
  });
});
