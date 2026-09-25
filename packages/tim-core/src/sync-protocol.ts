import { normalizeLwwTimestamp } from './lww.js';

export const SYNC_CAPABILITIES = {
  protocol_generation: 1,
  accepted_request_schema_majors: [1],
  accepted_envelope_versions: [1],
} as const;
export interface ProtocolBlob {
  proposed_id: string;
  entity_type: 'entry' | 'edge';
  entity_key: string;
  data: string;
  device_id: string;
  lww_device: string;
  updated_at: string;
}
export function validProtocolVersion(value: unknown): boolean {
  const v = value as Record<string, unknown> | null;
  return !!v && v.protocol_generation === 1 && v.client_schema_major === 1;
}
export function validProtocolBlob(value: unknown): value is ProtocolBlob {
  const b = value as ProtocolBlob | null;
  if (!b || !['entry', 'edge'].includes(b.entity_type)) return false;
  if (![b.proposed_id, b.entity_key, b.data, b.device_id, b.lww_device, b.updated_at]
    .every(v => typeof v === 'string' && v.length > 0)) return false;
  // Printable ASCII gives SQLite BINARY and JavaScript the same device order.
  if (!/^[\x21-\x7e]+$/.test(b.lww_device)) return false;
  if (b.proposed_id !== b.entity_key) return false;
  if (b.entity_type === 'edge' && (b.entity_key.split('|').length !== 3 || b.entity_key.split('|').some(p => !p))) return false;
  try { return normalizeLwwTimestamp(b.updated_at) === b.updated_at; } catch { return false; }
}
export function parseGenerationCursor(cursor: string, generation: string): number {
  const parts = cursor.split('|');
  if (parts.length !== 2 || parts[0] !== generation) throw new Error('Cursor generation mismatch');
  if (!/^(0|[1-9][0-9]*)$/.test(parts[1])) throw new Error('Malformed cursor');
  const id = Number(parts[1]);
  if (!Number.isSafeInteger(id)) throw new Error('Malformed cursor');
  return id;
}
