#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run discovery:preview-html [userId]
 *
 * Local-only convenience: renders the same preview HTML that the M4 server
 * exposes at GET /discovery/preview-html, writes it to /tmp, and opens it in
 * your default browser. For remote access (other devices on Tailscale), use
 * the server route directly — the data is always live there.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { runMigrations } from '../db/migrate';
import { seedUsers } from '../db/seed';
import { renderPreviewHtml } from '../modules/discovery/preview';

runMigrations();
seedUsers();

const targetArg = process.argv[2] ?? null;
const html = renderPreviewHtml(targetArg);

const outPath = path.join('/tmp', `eddy-preview-${(targetArg ?? 'all').toLowerCase()}.html`);
fs.writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);

execFile('open', [outPath], (err) => {
  if (err) console.error('Could not open browser:', err.message);
  process.exit(0);
});
