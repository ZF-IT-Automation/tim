/** Raised when unacked secret entries cannot be pushed without a secret passphrase. */
export class MissingSecretPassphraseError extends Error {
  readonly blockedCount: number;
  /** Non-secret rows pushed before the block (partial success). */
  readonly pushedCount: number;

  constructor(blockedCount: number, pushedCount = 0) {
    const partial = pushedCount > 0 ? ` (${pushedCount} non-secret ${pushedCount === 1 ? 'row' : 'rows'} pushed)` : '';
    super(
      `Cannot sync ${blockedCount} secret ${blockedCount === 1 ? 'entry' : 'entries'}: `
      + 'set TIM_SECRET_PASSPHRASE or pass --secret-passphrase'
      + partial,
    );
    this.name = 'MissingSecretPassphraseError';
    this.blockedCount = blockedCount;
    this.pushedCount = pushedCount;
  }
}

/** Resolve optional secret passphrase from CLI flags or environment. */
export function resolveSecretPassphrase(flags?: Record<string, string>): string | undefined {
  const fromFlag = flags?.['secret-passphrase'];
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.TIM_SECRET_PASSPHRASE;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}
