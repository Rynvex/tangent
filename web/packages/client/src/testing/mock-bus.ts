/**
 * In-memory event delivery for the mock client: the same handler contract as
 * `subscribeEvents` (typed handlers, onEvent, onStatus, onError), without a
 * network. Handlers that throw are reported to onError and do not stop others.
 */
import type { EventSubscription, SubscribeEventsOptions, TangentEvent, TangentEventDataMap, TangentEventType } from "../events";

type Subscription = Omit<SubscribeEventsOptions, "url" | "headers" | "credentials" | "fetch">;

export interface MockBus {
  subscribe(subscription: Subscription): EventSubscription;
  publish<K extends TangentEventType>(type: K, line: { lineId: string; rootLineId: string }, data: TangentEventDataMap[K]): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createMockBus(tenant: string, defer: (callback: () => void) => void): MockBus {
  let subscribers: readonly Subscription[] = [];

  const deliver = (subscription: Subscription, event: TangentEvent) => {
    const report = (error: unknown) => subscription.onError?.(asError(error), JSON.stringify(event));
    try {
      (subscription.handlers[event.type] as ((event: TangentEvent) => void) | undefined)?.(event);
    } catch (error) {
      report(error);
    }
    try {
      subscription.onEvent?.(event);
    } catch (error) {
      report(error);
    }
  };

  return {
    subscribe(subscription) {
      subscribers = [...subscribers, subscription];
      subscription.onStatus?.("connecting");
      let closed = false;
      defer(() => {
        if (!closed) subscription.onStatus?.("open");
      });
      return {
        close() {
          if (closed) return;
          closed = true;
          subscribers = subscribers.filter((item) => item !== subscription);
          subscription.onStatus?.("closed");
        },
        reconnect() {
          if (closed) return;
          subscription.onStatus?.("connecting");
          defer(() => {
            if (closed) return;
            subscription.onStatus?.("open");
            subscription.onReconnect?.();
          });
        },
      };
    },
    publish(type, line, data) {
      // The cast ties `data` to `type`, which TS cannot narrow across the generic.
      const event = { type, tenant, rootLineId: line.rootLineId, lineId: line.lineId, data } as TangentEvent;
      for (const subscription of subscribers) deliver(subscription, event);
    },
  };
}
