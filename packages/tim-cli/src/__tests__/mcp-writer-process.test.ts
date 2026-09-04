import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  isTimMcpServerScript,
  isTimMcpWriterPid,
  resolveMcpServerScriptPath,
  type ProcFs,
} from '../mcp-writer-process.js';
import { discoverTimMcpWriters } from '../writers.js';

function mockProcFs(opts: {
  cmdline: string;
  cwd: string;
}): ProcFs {
  return {
    exists: (p) => p.includes('/cmdline') || p.includes('/cwd'),
    readFile: (p) => {
      if (p.endsWith('/cmdline')) return opts.cmdline;
      throw new Error(`unexpected read: ${p}`);
    },
    readlink: (p) => {
      if (p.endsWith('/cwd')) return opts.cwd;
      throw new Error(`unexpected readlink: ${p}`);
    },
  };
}

describe('resolveMcpServerScriptPath', () => {
  it('resolves relative dist/server.js via /proc cwd', () => {
    const procFs = mockProcFs({
      cmdline: 'node\0dist/server.js\0',
      cwd: '/home/user/projects/tim/packages/tim-mcp',
    });
    const resolved = resolveMcpServerScriptPath('4242', procFs);
    expect(resolved).toBe(
      path.normalize('/home/user/projects/tim/packages/tim-mcp/dist/server.js'),
    );
    expect(isTimMcpServerScript(resolved!)).toBe(true);
  });

  it('accepts absolute tim-mcp server paths', () => {
    const script = '/home/user/projects/tim/packages/tim-mcp/dist/server.js';
    const procFs = mockProcFs({
      cmdline: `node\0${script}\0`,
      cwd: '/tmp',
    });
    expect(resolveMcpServerScriptPath('99', procFs)).toBe(script);
  });

  it('rejects shell commands that merely mention the pattern', () => {
    const procFs = mockProcFs({
      cmdline: 'bash\0-c\0pgrep -f dist/server.js\0',
      cwd: '/tmp',
    });
    expect(resolveMcpServerScriptPath('55', procFs)).toBeNull();
    expect(isTimMcpWriterPid('55', { procFs })).toBe(false);
  });
});

describe('discoverTimMcpWriters', () => {
  it('filters pgrep candidates through /proc identity checks', () => {
    const timMcp = '/x/packages/tim-mcp/dist/server.js';
    const procFs = mockProcFs({
      cmdline: `node\0${timMcp}\0`,
      cwd: '/x/packages/tim-mcp',
    });
    const result = discoverTimMcpWriters(
      () => '100 200\n',
      (pid) => isTimMcpWriterPid(pid, { procFs: pid === '100' ? procFs : mockProcFs({ cmdline: 'bash\0', cwd: '/tmp' }) }),
    );
    expect(result).toEqual({ ok: true, pids: ['100'] });
  });
});
