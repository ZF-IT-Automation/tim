/**
 * Minimal o9k-sync-compatible dev server for local testing (no auth).
 */
import http from 'node:http';
export declare function startDevServer(port?: number): http.Server;
export declare function resetDevServer(): void;
/** @internal test helper */
export declare function seedDevFile(id: string, salt: string): void;
//# sourceMappingURL=dev-server.d.ts.map