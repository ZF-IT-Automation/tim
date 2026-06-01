import type { TimStore } from 'tim-store';
export interface SpawnContext {
    sessionId: string;
    cwd: string;
}
export type Spawner = (command: string, ctx: SpawnContext) => void;
export interface SessionStopResult {
    spawned: boolean;
    reason: 'spawned' | 'no-marker' | 'below-threshold' | 'locked';
    pending?: number;
}
export declare const detachedSpawner: Spawner;
export declare function onSessionStop(store: TimStore, cwd: string, opts?: {
    spawn?: Spawner;
}): Promise<SessionStopResult>;
//# sourceMappingURL=session-hooks.d.ts.map