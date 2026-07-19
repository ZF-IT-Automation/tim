import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type TimConfigFile } from 'tim-core';
import { TimStore } from 'tim-store';
import { inspectHmemManifest, tim_import } from 'tim-migrate';
import {
  collectBindingReport,
  formatBindingFindingLine,
  type ProjectBindingFinding,
} from 'tim-hooks';
import { runSnapshot } from './snapshot.js';
import { parseArgs, valueOptionsFor } from './args.js';

export interface HmemWizardStep {
  id: string;
  description: string;
}

export interface MigrateFromHmemOptions {
  deduplicate?: boolean;
}

export function buildMigrateFromHmemPlan(
  source: string,
  opts: MigrateFromHmemOptions = {},
): HmemWizardStep[] {
  const deduplicate = opts.deduplicate !== false;
  return [
    { id: 'manifest', description: `Inspect ${source}` },
    { id: 'dry-run', description: `Import dry-run with deduplicate=${deduplicate}` },
    { id: 'snapshot', description: 'Create TIM snapshot before writing' },
    { id: 'import', description: 'Run live import' },
    { id: 'audit', description: 'Run import audit and print repair suggestions' },
    { id: 'doctor', description: 'Run TIM doctor' },
    { id: 'bindings', description: 'Report per-imported-project binding state on this device' },
    { id: 'handoff', description: 'Print source, snapshot, counts, warnings, next steps' },
  ];
}

export function evaluateDryRunGate(report: { format: string; warnings: string[] }): string[] {
  const blockers: string[] = [];
  if (report.format === 'unknown') {
    blockers.push('Dry-run could not identify the source hmem format.');
  }
  for (const warning of report.warnings) {
    blockers.push(`Dry-run warning: ${warning}`);
  }
  return blockers;
}

export function buildImportAuditArgs(source: string): { source: string; includeRepairPlan: true } {
  return { source, includeRepairPlan: true };
}

/** Labels for project roots imported from hmem (metadata.hmemUid present). */
export async function listHmemImportedProjectLabels(store: TimStore): Promise<string[]> {
  const labels: string[] = [];
  for (const row of await store.listProjects()) {
    const entry = await store.read(row.id);
    if (!entry || entry.metadata.kind !== 'project') continue;
    if (entry.metadata.hmemUid) labels.push(row.label);
  }
  return labels.sort();
}

/** Binding findings for hmem-imported projects only — reuses doctor classification. */
export async function collectMigrationProjectBindings(
  store: TimStore,
): Promise<ProjectBindingFinding[]> {
  const importedLabels = new Set(await listHmemImportedProjectLabels(store));
  const { projects } = await collectBindingReport(store);
  return projects.filter(project => importedLabels.has(project.label));
}

export function formatMigrationBindingLines(findings: ProjectBindingFinding[]): string[] {
  return findings.map(finding => formatBindingFindingLine(finding).trimStart());
}

function getDbPath(config: TimConfigFile): string {
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

function resolveDeduplicate(flags: Record<string, string>): boolean {
  if (flags['no-deduplicate'] === 'true') return false;
  if (flags.deduplicate === 'false') return false;
  return true;
}

export async function cmdMigrateFromHmem(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args, {
    valueOptions: valueOptionsFor('migrate-from-hmem'),
  });
  const sourcePath = positional[0];

  if (!sourcePath) {
    console.error('Usage: tim migrate-from-hmem <path.hmem> [--deduplicate] [--no-deduplicate] [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`hmem source not found: ${sourcePath}`);
    process.exit(1);
  }

  const dryRunOnly = flags['dry-run'] === 'true';
  const deduplicate = resolveDeduplicate(flags);
  const config = loadConfig();
  const dbPath = getDbPath(config);
  const manifest = inspectHmemManifest(sourcePath);
  const plan = buildMigrateFromHmemPlan(sourcePath, { deduplicate });

  let store = new TimStore(dbPath);
  let dryRunReport;
  try {
    dryRunReport = tim_import(store, sourcePath, { dryRun: true, deduplicate });
  } finally {
    store.close();
  }
  const dryRunBlockers = evaluateDryRunGate(dryRunReport);

  if (dryRunOnly) {
    console.log(JSON.stringify({
      sourcePath,
      dbPath,
      dryRun: true,
      deduplicate,
      plan: plan.filter(step => step.id === 'manifest' || step.id === 'dry-run' || step.id === 'handoff'),
      manifest,
      dryRunReport,
      dryRunBlockers,
      nextSteps: [
        'Run without --dry-run to snapshot the TIM database and import.',
        'After live import, run MCP tool tim_import_audit for structure verification.',
      ],
    }, null, 2));
    return;
  }

  if (dryRunBlockers.length > 0) {
    console.error(JSON.stringify({
      sourcePath,
      dbPath,
      dryRun: false,
      blocked: true,
      manifest,
      dryRunReport,
      blockers: dryRunBlockers,
      nextSteps: [
        'Resolve the dry-run blockers or inspect the source .hmem before retrying.',
        'Run with --dry-run to review the full manifest and dry-run report without writing.',
      ],
    }, null, 2));
    process.exit(1);
  }

  const snapshot = await runSnapshot({ dbPath, quiet: true });
  if (!snapshot.ok) {
    console.error(`snapshot failed before import: ${snapshot.error}`);
    process.exit(1);
  }

  store = new TimStore(dbPath);
  try {
    const importReport = tim_import(store, sourcePath, { deduplicate });
    const health = await store.health();
    const bindingFindings = await collectMigrationProjectBindings(store);
    const bindingLines = formatMigrationBindingLines(bindingFindings);
    const warnings = [
      ...dryRunReport.warnings,
      ...importReport.warnings,
      ...health.issues,
    ];

    console.log(JSON.stringify({
      sourcePath,
      dbPath,
      dryRun: false,
      deduplicate,
      plan,
      manifest,
      snapshot,
      dryRunReport,
      importReport,
      doctor: {
        status: health.status,
        blockers: health.blockers,
        warnings: health.warnings,
        totalEntries: health.totalEntries,
        brokenLinks: health.brokenLinks,
        orphanEntries: health.orphanEntries,
        ftsIntegrity: health.ftsIntegrity,
      },
      bindings: {
        projects: bindingFindings,
        lines: bindingLines,
      },
      audit: {
        tool: 'tim_import_audit',
        args: buildImportAuditArgs(sourcePath),
        guidance: 'Run the MCP tool after import. If it reports WARNING/BLOCKER, apply the repairPlan manually or with an explicit follow-up.',
      },
      warnings,
      nextSteps: [
        'Run MCP tool tim_import_audit with includeRepairPlan=true.',
        'Review imported project roots and O-entry nesting against docs/hmem-to-tim-migration.md.',
        'For each imported project: bind via `tim bind-project --label P#### --cwd <dir>` (ask the user when metadata.path is absent) or record it as intentionally memory-only; never hand-write `.tim-project`.',
        'Run tim doctor again after binding or any manual repair.',
      ],
    }, null, 2));
  } finally {
    store.close();
  }
}
