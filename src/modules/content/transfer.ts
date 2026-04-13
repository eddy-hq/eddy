import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../logger';

const execFileAsync = promisify(execFile);

// Transfers a downloaded file to the Ubuntu media server via rsync over SSH.
// Returns the remote file path.
export async function transferToUbuntu(localPath: string, youtubeId: string): Promise<string> {
  const sshUser = config.VIDEO_SSH_USER;
  const sshHost = config.VIDEO_SSH_HOST;
  const sshKey = (config.VIDEO_SSH_KEY ?? '~/.ssh/id_ed25519_eddy').replace('~', process.env['HOME'] ?? '~');
  const remotePath = config.VIDEO_REMOTE_PATH;

  if (!sshUser || !sshHost || !remotePath) {
    throw new Error('VIDEO_SSH_USER, VIDEO_SSH_HOST, and VIDEO_REMOTE_PATH must be set');
  }

  const remoteFile = path.posix.join(remotePath, `${youtubeId}.mp4`);
  const destination = `${sshUser}@${sshHost}:${remotePath}/`;

  logger.info({ youtubeId, destination }, 'Starting rsync transfer');

  await execFileAsync('rsync', [
    '--archive',
    '--checksum',
    '--compress',
    '-e', `ssh -i ${sshKey} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
    localPath,
    destination,
  ], { maxBuffer: 10 * 1024 * 1024 });

  logger.info({ youtubeId, remoteFile }, 'rsync transfer complete');
  return remoteFile;
}
