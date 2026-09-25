import { parseExpression } from 'cron-parser';

// Validators for .env values that zod can't check on shape alone. Kept out of
// config.ts so they can be tested without parsing the real environment.

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// A five-field cron pattern BullMQ will accept: parsed with the same
// cron-parser BullMQ's job scheduler uses, so a bad range or syntax fails at
// startup rather than leaving the schedule silently unregistered.
export function isFiveFieldCron(pattern: string): boolean {
  if (!/^\S+(\s+\S+){4}$/.test(pattern.trim())) return false;
  try {
    parseExpression(pattern);
    return true;
  } catch {
    return false;
  }
}
