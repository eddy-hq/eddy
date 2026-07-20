// Maps the configured IP stack to the yt-dlp argv that pins it. Shared by every
// yt-dlp seam (anonymous M4 metadata, worker download path, resume probe) so all
// probes and downloads share one IP-stack reputation bucket: YouTube's blocks
// are per-IP-stack, and IPv6 reputation is per-/64, so an unpinned mix lets a
// download taint the probe's stack (or vice versa).
export type IpStack = 'ipv4' | 'ipv6' | 'auto';

export function ipStackArgs(stack: IpStack): string[] {
  switch (stack) {
    case 'ipv4':
      return ['--force-ipv4'];
    case 'ipv6':
      return ['--force-ipv6'];
    case 'auto':
      return [];
  }
}
