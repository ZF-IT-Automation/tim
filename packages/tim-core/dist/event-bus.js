"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InProcessEventBus = void 0;
class InProcessEventBus {
    handlers = new Map();
    on(type, handler) {
        if (!this.handlers.has(type)) {
            this.handlers.set(type, new Set());
        }
        this.handlers.get(type).add(handler);
    }
    off(type, handler) {
        this.handlers.get(type)?.delete(handler);
    }
    async emit(type, payload) {
        const event = {
            type,
            timestamp: new Date().toISOString(),
            payload,
        };
        const handlers = this.handlers.get(type);
        if (!handlers)
            return;
        for (const handler of handlers) {
            try {
                await handler(event);
            }
            catch (err) {
                console.error(`[EventBus] handler failed (${type}):`, err);
            }
        }
    }
}
exports.InProcessEventBus = InProcessEventBus;
//# sourceMappingURL=event-bus.js.map