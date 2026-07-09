export function requiresSnapshot(command: string, flags: Record<string, unknown>): boolean {
  if (flags.dryRun === true || flags['dry-run'] === 'true') return false;
  return ['import', 'repair-flags', 'migrate-from-hmem'].includes(command);
}

export function requiresConfirm(command: string, flags: Record<string, unknown>): boolean {
  const force = flags.force === true || flags.force === 'true';
  const hard = flags.hard === true || flags.hard === 'true';
  if (command === 'restore' && force) return true;
  if (command === 'delete-batch' && hard) return true;
  return false;
}
