/** Raised when unacked secret entries cannot be pushed without a secret passphrase. */
export class MissingSecretPassphraseError extends Error {
  readonly blockedCount: number;

  constructor(blockedCount: number) {
    super(
      `Cannot sync ${blockedCount} secret ${blockedCount === 1 ? 'entry' : 'entries'}: `
      + 'set TIM_SECRET_PASSPHRASE or pass --secret-passphrase',
    );
    this.name = 'MissingSecretPassphraseError';
    this.blockedCount = blockedCount;
  }
}

/** Resolve optional secret passphrase from CLI flags or environment. */
export function resolveSecretPassphrase(flags?: Record<string, string>): string | undefined {
  const fromFlag = flags?.['secret-passphrase'];
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.TIM_SECRET_PASSPHRASE;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}
