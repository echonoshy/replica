import type { NudgesQuery } from "@replica/shared";
import { spaceKey } from "../../db/interfaces.js";
import type { Store } from "./store.js";
import { iso } from "./time.js";

type Subscription = { key: string; refresh(): void; close(): void };
export class NudgeStreams {
  private readonly subscriptions = new Set<Subscription>();
  constructor(private readonly store: Store, private readonly clock: () => number) {}
  notify(key: string) {
    for (const sub of this.subscriptions) if (sub.key === key) sub.refresh();
  }
  close() { for (const sub of this.subscriptions) sub.close(); }

  open(query: NudgesQuery, signal: AbortSignal) {
    const store = this.store, clock = this.clock, subscriptions = this.subscriptions;
    const key = spaceKey(query), offset = query.now ? Date.parse(query.now) - clock() : 0;
    let dispose = () => {};
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        let timer: NodeJS.Timeout | undefined;
        let cursor = 0, last = iso(clock() + offset), closed = false;
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));
        function detach() {
          closed = true;
          clearTimeout(timer);
          subscriptions.delete(sub);
          signal.removeEventListener("abort", close);
        }
        function close() {
          if (closed) return;
          detach();
          try { controller.close(); } catch { /* Stream controller already closed or errored. */ }
        }
        function arm() {
          clearTimeout(timer);
          const next = store.nextDelivery(key, last);
          const wait = next ? Math.max(1, Math.min(15_000, Date.parse(next) - clock() - offset)) : 15_000;
          timer = setTimeout(() => refresh(true), wait).unref();
        }
        function refresh(heartbeat = false) {
          if (closed) return;
          try {
            const now = iso(Math.max(Date.parse(last), clock() + offset));
            const events = store.connection.client.transaction(() => {
              const rows = store.visibleSince(key, cursor, last, now);
              cursor = store.watermark(key);
              return rows;
            })();
            last = now;
            for (const n of events) {
              if ((controller.desiredSize ?? 0) <= -64) { close(); return; }
              send("nudge", n);
            }
            if (heartbeat && !events.length) {
              if ((controller.desiredSize ?? 0) <= -64) { close(); return; }
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            }
            arm();
          } catch { close(); }
        }
        const sub = { key, refresh, close };
        dispose = detach;
        if (signal.aborted) { close(); return; }
        const snapshot = store.connection.client.transaction(() => {
          cursor = store.watermark(key);
          return store.list({ ...query, status: "pending" }, last);
        })();
        send("snapshot", snapshot);
        subscriptions.add(sub);
        signal.addEventListener("abort", close, { once: true });
        arm();
      },
      cancel() { dispose(); },
    });
  }
}
