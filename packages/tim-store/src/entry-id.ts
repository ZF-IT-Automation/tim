import { ulid } from 'ulid';
import * as os from 'os';

/** First 6 chars of session id from write metadata, else `ns`. */
export function sessionShortFromMetadata(metadata?: Record<string, unknown>): string {
  const raw = metadata?.sessionId ?? metadata?.session_id;
  if (typeof raw === 'string' && raw.length > 0) {
    return raw.slice(0, 6);
  }
  return 'ns';
}

/** `{device}-{MMDD}-{session_short}-{ulid}` */
export function formatEntryId(options: {
  metadata?: Record<string, unknown>;
  now?: Date;
  device?: string;
} = {}): string {
  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const device = (options.device ?? os.hostname()).slice(0, 4).toLowerCase();
  const date = `${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  const sessionShort = sessionShortFromMetadata(options.metadata);
  return `${device}-${date}-${sessionShort}-${ulid()}`;
}
