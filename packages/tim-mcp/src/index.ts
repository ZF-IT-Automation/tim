export { startServer, createHttpServer, createMcpServer } from './server.js';
export type { HttpServerHandle } from './server.js';
// Re-exported for `tim viewer`, which lists tools and renders their parameter
// forms from the same registry the server answers ListTools from.
export { TOOL_DEFS, toolInputSchema } from './server.js';
export type { ToolInputSchema } from './server.js';
export { formatProjectOutput } from './project-output.js';
export type { ProjectSchema, ProjectSchemaSection } from './project-output.js';
