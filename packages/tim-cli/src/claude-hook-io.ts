const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;

export async function readJsonStdin(
  maxBytes = DEFAULT_MAX_STDIN_BYTES,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;

  for await (const chunk of process.stdin) {
    if (oversized) continue;

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }

  if (oversized || bytes === 0) return null;

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function promptSubmitEnvelope(context: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  };
}

export function sessionStartEnvelope(context: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  };
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The envelope tim-session-start.sh picks per harness, for hosts that run the
 * start hook through node instead (no jq, no PATH lookup). Outside Claude Code the
 * MCP server sees no session id, so the directive hands over the one the turn-end
 * hooks log under.
 */
export function agentSessionStartEnvelope(payload: Record<string, unknown>, directive: string) {
  if (payload.hook_event_name === 'SessionStart' || payload.hookSpecificOutput) {
    return sessionStartEnvelope(directive);
  }
  const sid = text(payload.conversation_id) || text(payload.session_id);
  const context = sid
    ? `${directive}\nTIM session id: ${sid} — pass it as sessionId to tim_session_start / tim_load_project; never invent one.`
    : directive;
  if (text(payload.conversation_id) || text(payload.additional_context)) return { additional_context: context };
  if (text(payload.session_id)) return { context };
  return { additional_context: context };
}
