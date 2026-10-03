// Copied next to the checkout's node_modules and run there: a stdio MCP round trip.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
const here = decodeURIComponent(path.dirname(new URL(import.meta.url).pathname));
const t = new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'packages/tim-mcp/dist/server.js')], env: { ...process.env }, cwd: `${process.env.HOME}/demo` });
const c = new Client({ name: 'smoke', version: '1' });
await c.connect(t);
const { tools } = await c.listTools();
console.log('tools:', tools.length);
let bad = 0;
const call = async (name, args, expect) => {
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content?.map(x => x.text).join('\n') ?? '';
  const ok = !r.isError && (!expect || txt.includes(expect));
  if (!ok) bad++;
  console.log(`[${ok ? 'OK ' : 'BAD'}] ${name}: ${txt.slice(0, 160).replace(/\n/g, ' ')}`);
};
await call('tim_load_project', { label: 'P0001' }, 'P0001');
await call('tim_write', { where: 'P0001/Decisions', title: 'Use SQLite', content: 'We chose SQLite for local simplicity.', tags: ['#storage'], metadata: { type: 'decision' } });
await call('tim_search', { query: 'SQLite', root: 'P0001' }, 'Use SQLite');
await call('tim_show', { what: 'decisions', root: 'P0001' }, 'Use SQLite');
await call('tim_resume_topic', { topic: 'database', project: 'P0001' }, 'SQLite');
await c.close();
console.log(bad ? `MCP smoke: ${bad} FAILED` : 'MCP smoke: ALL OK');
process.exit(bad ? 1 : 0);
