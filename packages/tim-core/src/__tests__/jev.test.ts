import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askJev, jevNoul, resolveJevApiKey } from '../jev.js';

const question = { e0: { type: 'noul' as const, instructions: 'Is E0 about the topic?' } };
const logPath = () => path.join(os.homedir(), '.tim', 'logs', 'jev.log');

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JEV_API_KEY;
});

describe('askJev', () => {
  it('returns null without calling the network when no key is configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await askJev('test', 'state', question)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the answers on a well-formed reply', async () => {
    process.env.JEV_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ answers: { e0: { type: 'noul', noul: 0.9 } } }))));
    const answers = await askJev('test', 'state', question);
    expect(answers && jevNoul(answers, 'e0')).toBe(0.9);
  });

  it('fails open and logs on a non-200 or a reply missing a question', async () => {
    process.env.JEV_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 429 })));
    expect(await askJev('test-429', 'state', question)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: {} }))));
    expect(await askJev('test-missing', 'state', question)).toBeNull();
    const log = fs.readFileSync(logPath(), 'utf-8');
    expect(log).toContain('test-429 http 429');
    expect(log).toContain('test-missing malformed reply');
  });

  it('does not count a non-number noul as a judgement', () => {
    expect(jevNoul({ e0: { type: 'noul', noul: true as unknown as number } }, 'e0')).toBeUndefined();
    expect(jevNoul({ e0: { type: 'noul', noul: '0.9' as unknown as number } }, 'e0')).toBeUndefined();
  });
});

describe('resolveJevApiKey', () => {
  it('strips export and shell quotes from the env file', () => {
    const dir = path.join(os.homedir(), '.config', 'jev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'env'), 'export JEV_API_KEY="sk-quoted"\n');
    expect(resolveJevApiKey()).toBe('sk-quoted');
    fs.rmSync(dir, { recursive: true });
  });
});
