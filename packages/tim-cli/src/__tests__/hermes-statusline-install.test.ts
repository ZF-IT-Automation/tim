import { describe, it, expect } from 'vitest';
import {
  ensureCacheHookInConfig,
  isHermesCliPatched,
  patchHermesCliSource,
} from '../hermes-statusline-install.js';

describe('hermes-statusline-install', () => {
  it('ensureCacheHookInConfig is idempotent', () => {
    const base = `hooks:
  pre_llm_call:
  - command: ~/.hermes/agent-hooks/o9k-startup.sh
    timeout: 10
  - command: ~/.hermes/agent-hooks/tim-session-start.sh
    timeout: 10
`;
    const first = ensureCacheHookInConfig(base);
    expect(first.changed).toBe(true);
    expect(first.yaml).toContain('tim-hermes-session-cache.sh');
    const second = ensureCacheHookInConfig(first.yaml);
    expect(second.changed).toBe(false);
  });

  it('detects patched cli.py', () => {
    expect(
      isHermesCliPatched(
        'def _get_tim_status(self):\n@staticmethod\n    def _status_bar_display_width',
      ),
    ).toBe(true);
    expect(
      isHermesCliPatched('@staticmethod\n    def _get_tim_status(self):'),
    ).toBe(false);
    expect(isHermesCliPatched('def _get_hmem_status(self):')).toBe(false);
  });

  it('patchHermesCliSource keeps @staticmethod on _status_bar_display_width', () => {
    const src = [
      '    @staticmethod',
      '    def _status_bar_display_width(text: str) -> int:',
      '        return len(text or "")',
    ].join('\n');
    const { source } = patchHermesCliSource(src);
    expect(source).toContain('@staticmethod\n    def _status_bar_display_width');
    expect(source).toMatch(/def _get_tim_status\(self\)/);
    expect(source).not.toMatch(/@staticmethod\n    def _get_tim_status/);
  });

  it('patchHermesCliSource repairs broken decorator swap', () => {
    const broken = [
      '    @staticmethod',
      '    def _get_tim_status(self) -> Dict[str, str]:',
      '        return {}',
      '    def _status_bar_display_width(text: str) -> int:',
      '        return 1',
    ].join('\n');
    const { source, changed } = patchHermesCliSource(broken);
    expect(changed).toBe(true);
    expect(source).toContain('@staticmethod\n    def _status_bar_display_width');
    expect(source).not.toMatch(/@staticmethod\n    def _get_tim_status/);
  });

  it('patchHermesCliSource converts hmem hook to tim', () => {
    const src = 'def _get_hmem_status(self):\n    script = "~/.hermes/agent-hooks/hmem-statusline.sh"\n';
    const { source, changed } = patchHermesCliSource(src);
    expect(changed).toBe(true);
    expect(source).toContain('tim-hermes-statusline.sh');
    expect(source).toContain('_get_tim_status');
  });
});
