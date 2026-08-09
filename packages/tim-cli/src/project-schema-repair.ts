import { TimStore, ensureProjectSchema, planProjectSchema } from 'tim-store';

export interface ProjectSchemaFinding {
  label: string;
  title: string;
  /** Schema sections the project does not have yet (slash paths). */
  missing: string[];
  /** Section titles the project has that the schema does not describe — never touched. */
  unknown: string[];
  /** Legacy sections titled with their own description, as `old → new`. */
  renamed: string[];
}

export interface ProjectSchemaRepairOutcome {
  label: string;
  added: string[];
  renamed: string[];
  error?: string;
}

/**
 * Read-only survey of every project against the standard schema.
 * `projectFilter` limits it to one label/alias.
 */
export async function collectProjectSchemaReport(
  store: TimStore,
  projectFilter?: string,
): Promise<ProjectSchemaFinding[]> {
  const projects = await store.listProjects();
  const findings: ProjectSchemaFinding[] = [];

  for (const project of projects) {
    if (projectFilter && project.label !== projectFilter) continue;
    try {
      const plan = await planProjectSchema(store, project.id);
      findings.push({
        label: project.label,
        title: project.title,
        missing: plan.created,
        unknown: plan.unknown,
        renamed: plan.renamed,
      });
    } catch {
      // A project that cannot be resolved (tombstoned mid-scan, ambiguous alias)
      // is not a schema problem — skip it rather than failing the whole report.
    }
  }

  return findings;
}

export function formatProjectSchemaFindingLine(finding: ProjectSchemaFinding): string {
  const parts: string[] = [];
  parts.push(
    finding.missing.length === 0
      ? '✓ complete'
      : `${finding.missing.length} missing: ${finding.missing.join(', ')}`,
  );
  if (finding.renamed.length > 0) {
    parts.push(`${finding.renamed.length} mistitled: ${finding.renamed.join(', ')}`);
  }
  if (finding.unknown.length > 0) {
    parts.push(`custom (kept): ${finding.unknown.join(', ')}`);
  }
  return `  ${finding.label} ${finding.title} — ${parts.join(' | ')}`;
}

/** A project needs repair when sections are missing OR mistitled. */
export function needsSchemaRepair(finding: ProjectSchemaFinding): boolean {
  return finding.missing.length > 0 || finding.renamed.length > 0;
}

export function formatProjectSchemaOutcomeLine(outcome: ProjectSchemaRepairOutcome): string {
  if (outcome.error) return `  ✗ ${outcome.label}: ${outcome.error}`;
  const parts: string[] = [];
  if (outcome.added.length > 0) parts.push(`added ${outcome.added.join(', ')}`);
  if (outcome.renamed.length > 0) parts.push(`retitled ${outcome.renamed.join(', ')}`);
  if (parts.length === 0) return `  ⊘ ${outcome.label}: already complete`;
  return `  ✓ ${outcome.label}: ${parts.join('; ')}`;
}

/**
 * Repair a project against the schema: create the sections it lacks, and retitle
 * legacy sections that carry a schema label under their own description (see
 * ensureProjectSchema — the alternative would strand their content behind a
 * correctly-titled twin). Nothing is moved or deleted, and sections outside the
 * schema stay exactly as they are.
 */
export async function repairProjectSchemas(
  store: TimStore,
  findings: ProjectSchemaFinding[],
): Promise<ProjectSchemaRepairOutcome[]> {
  const outcomes: ProjectSchemaRepairOutcome[] = [];
  for (const finding of findings) {
    if (!needsSchemaRepair(finding)) continue;
    try {
      const result = await ensureProjectSchema(store, finding.label);
      outcomes.push({ label: finding.label, added: result.created, renamed: result.renamed });
    } catch (err) {
      outcomes.push({
        label: finding.label,
        added: [],
        renamed: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}
