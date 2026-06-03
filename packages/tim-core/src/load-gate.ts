/**
 * Pure gate decision for tim_load_project: one bind per session unless same-project refresh.
 * P0000 Inbox counts as unbound — first real project load always allowed.
 */
export function evaluateLoadGate(
  existingProjectRef: string | undefined | null,
  requestedLabel: string,
): 'bind' | 'reject' {
  if (!existingProjectRef || existingProjectRef === 'P0000') {
    return 'bind';
  }
  if (existingProjectRef === requestedLabel) {
    return 'bind';
  }
  return 'reject';
}
