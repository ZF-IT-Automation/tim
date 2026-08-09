import { describe, it, expect } from 'vitest';
import { PROJECT_SCHEMA, findSchemaSection } from 'tim-core';
import { applySectionEntryType, validateBugStatus } from '../write-validate.js';

const section = (name: string) => findSchemaSection(PROJECT_SCHEMA.sections, name);

describe('project schema entry_type', () => {
  it('declares a type on the collection sections that have a reader', () => {
    expect(section('Bugs')?.entry_type).toBe('bug');
    expect(section('Tasks')?.entry_type).toBe('task');
    expect(section('Ideas')?.entry_type).toBe('idea');
  });

  it('leaves prose sections untyped', () => {
    for (const name of ['Log', 'Roadmap', 'Decisions', 'Codebase', 'Usage', 'Rules', 'Overview']) {
      expect(section(name)?.entry_type, name).toBeUndefined();
    }
  });

  it('no longer carries Next Steps', () => {
    expect(section('Next Steps')).toBeUndefined();
    expect(section('Previous Steps')).toBeUndefined();
  });
});

describe('applySectionEntryType', () => {
  it('stamps a bug marker on a child of Bugs', () => {
    expect(applySectionEntryType({}, 'Bugs', 'section')).toEqual({
      type: 'bug',
      bug: { status: 'open' },
    });
  });

  it('stamps a task marker on a child of Tasks and an idea marker on a child of Ideas', () => {
    expect(applySectionEntryType({}, 'Tasks', 'section')).toEqual({
      type: 'task',
      task: { status: 'todo', priority: 'medium' },
    });
    expect(applySectionEntryType({}, 'Ideas', 'section')).toEqual({
      type: 'idea',
      idea: { status: 'new' },
    });
  });

  it('never overrides a caller who classified the entry', () => {
    const explicitType = { type: 'note' };
    expect(applySectionEntryType(explicitType, 'Bugs', 'section')).toBe(explicitType);

    const explicitMarker = { task: { status: 'done' } };
    expect(applySectionEntryType(explicitMarker, 'Bugs', 'section')).toBe(explicitMarker);
  });

  it("adds the missing type when the caller passed the section's own marker", () => {
    expect(applySectionEntryType({ bug: { status: 'open' } }, 'Bugs', 'section')).toEqual({
      type: 'bug',
      bug: { status: 'open' },
    });
    expect(applySectionEntryType({ task: { status: 'todo' } }, 'Tasks', 'section')).toEqual({
      type: 'task',
      task: { status: 'todo' },
    });
  });

  it('leaves schema entries and untyped sections alone', () => {
    const sectionMeta = { kind: 'section' };
    expect(applySectionEntryType(sectionMeta, 'Bugs', 'section')).toBe(sectionMeta);

    const meta = {};
    expect(applySectionEntryType(meta, 'Log', 'section')).toBe(meta);
    expect(applySectionEntryType(meta, 'Bugs', undefined)).toBe(meta);
    expect(applySectionEntryType(meta, undefined, 'section')).toBe(meta);
  });
});

describe('validateBugStatus', () => {
  it("refuses 'fixed' without the commit that fixed it", () => {
    const res = validateBugStatus({ bug: { status: 'fixed' } });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toMatch(/metadata\.bug\.commit/);
  });

  it("accepts 'fixed' with a commit", () => {
    expect(validateBugStatus({ bug: { status: 'fixed', commit: '5f0c5fc' } }).ok).toBe(true);
  });

  it('rejects a blank commit rather than counting it as evidence', () => {
    expect(validateBugStatus({ bug: { status: 'fixed', commit: '   ' } }).ok).toBe(false);
  });

  it('lets a bug close without a fix under the other statuses', () => {
    for (const status of ['open', 'documented', 'wontfix', 'duplicate']) {
      expect(validateBugStatus({ bug: { status } }).ok, status).toBe(true);
    }
  });

  it('exempts bugs the migration marked as legacy closures', () => {
    expect(validateBugStatus({ bug: { status: 'fixed', legacy: true } }).ok).toBe(true);
  });

  it('ignores entries that are not bugs', () => {
    expect(validateBugStatus({ task: { status: 'done' } }).ok).toBe(true);
    expect(validateBugStatus(undefined).ok).toBe(true);
    expect(validateBugStatus({ bug: 'not an object' }).ok).toBe(true);
  });
});
