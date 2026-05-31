import type { EventBus, EventHandler, EventType } from './index.js';
export declare class InProcessEventBus implements EventBus {
    private handlers;
    on(type: EventType, handler: EventHandler): void;
    off(type: EventType, handler: EventHandler): void;
    emit(type: EventType, payload: unknown): Promise<void>;
}
//# sourceMappingURL=event-bus.d.ts.map