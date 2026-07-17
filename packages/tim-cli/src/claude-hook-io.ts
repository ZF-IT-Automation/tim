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
