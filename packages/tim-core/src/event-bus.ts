import type { EventBus, EventHandler, EventType, MemoryEvent } from './index.js';

export class InProcessEventBus implements EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();

  on(type: EventType, handler: EventHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  off(type: EventType, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  async emit(type: EventType, payload: unknown): Promise<void> {
    const event: MemoryEvent = {
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    const handlers = this.handlers.get(type);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[EventBus] handler failed (${type}):`, err);
      }
    }
  }
}
