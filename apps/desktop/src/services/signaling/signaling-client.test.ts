import { describe, expect, it } from "vitest";
import { SignalingClient, type SocketLike } from "./signaling-client.js";

/** A socket that goes nowhere and does exactly what a test tells it to. */
class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // --- test controls ---
  open(): void {
    this.onopen?.();
  }
  drop(): void {
    this.onclose?.();
  }
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  deliverRaw(data: string): void {
    this.onmessage?.({ data });
  }
}

/** Collects scheduled callbacks so tests can advance time by hand. */
function fakeClock() {
  const pending = new Map<number, { handler: () => void; ms: number }>();
  let nextHandle = 1;

  return {
    setTimeoutFn: (handler: () => void, ms: number) => {
      const handle = nextHandle++;
      pending.set(handle, { handler, ms });
      return handle;
    },
    clearTimeoutFn: (handle: number) => {
      pending.delete(handle);
    },
    get pendingCount() {
      return pending.size;
    },
    lastDelay(): number | undefined {
      return [...pending.values()].at(-1)?.ms;
    },
    runAll(): void {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, { handler }] of entries) handler();
    },
  };
}

function setup(options: { maxAttempts?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const clock = fakeClock();
  const states: string[] = [];

  const client = new SignalingClient({
    url: "ws://test",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backoffMs: [100, 200, 400],
    maxAttempts: options.maxAttempts ?? 3,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    random: () => 1, // no jitter, so delays are predictable
  });

  client.onStateChange((state) => states.push(state));

  return { client, sockets, clock, states, latest: () => sockets.at(-1)! };
}

describe("SignalingClient", () => {
  it("reports connecting then connected", () => {
    const { client, latest, states } = setup();
    client.connect();
    expect(states).toEqual(["connecting"]);

    latest().open();
    expect(states).toEqual(["connecting", "connected"]);
    expect(client.state).toBe("connected");
  });

  it("serializes outbound messages", () => {
    const { client, latest } = setup();
    client.connect();
    latest().open();

    client.send({ type: "join-channel", channelId: "7DS4B2", displayName: "PC-SAM" });
    expect(JSON.parse(latest().sent[0]!)).toEqual({ type: "join-channel", channelId: "7DS4B2", displayName: "PC-SAM" });
  });

  it("refuses to send before the socket is open", () => {
    const { client } = setup();
    client.connect();
    expect(() => client.send({ type: "create-channel", displayName: "PC-SAM" })).toThrow(/not connected/);
  });

  it("hands parsed messages to listeners", () => {
    const { client, latest } = setup();
    const received: unknown[] = [];
    client.onMessage((message) => received.push(message));

    client.connect();
    latest().open();
    latest().deliver({ type: "viewer-joined", viewerId: "v1" });

    expect(received).toEqual([{ type: "viewer-joined", viewerId: "v1" }]);
  });

  it("ignores an unparseable frame instead of dropping the session", () => {
    const { client, latest } = setup();
    const received: unknown[] = [];
    client.onMessage((message) => received.push(message));

    client.connect();
    latest().open();
    latest().deliverRaw("{not json");

    expect(received).toEqual([]);
    expect(client.state).toBe("connected");
  });

  it("reconnects after an unexpected drop", () => {
    const { client, sockets, clock, latest } = setup();
    client.connect();
    latest().open();

    latest().drop();
    expect(client.state).toBe("reconnecting");
    expect(clock.pendingCount).toBe(1);

    clock.runAll();
    expect(sockets).toHaveLength(2);

    latest().open();
    expect(client.state).toBe("connected");
  });

  it("backs off further on each successive failure", () => {
    const { client, clock, latest } = setup();
    client.connect();
    latest().open();

    latest().drop();
    expect(clock.lastDelay()).toBe(100);
    clock.runAll();

    latest().drop();
    expect(clock.lastDelay()).toBe(200);
    clock.runAll();

    latest().drop();
    expect(clock.lastDelay()).toBe(400);
  });

  it("resets the backoff once a connection succeeds", () => {
    const { client, clock, latest } = setup();
    client.connect();
    latest().open();

    latest().drop();
    clock.runAll();
    latest().open(); // recovered

    latest().drop();
    expect(clock.lastDelay()).toBe(100);
  });

  it("gives up after the attempt limit and reports failure", () => {
    const { client, clock, latest } = setup({ maxAttempts: 2 });
    client.connect();
    latest().open();

    latest().drop();
    clock.runAll();
    latest().drop();
    clock.runAll();
    latest().drop();

    expect(client.state).toBe("failed");
    expect(clock.pendingCount).toBe(0);
  });

  it("does not reconnect after a deliberate close", () => {
    const { client, sockets, clock, latest } = setup();
    client.connect();
    latest().open();

    client.close();
    latest().drop();

    expect(clock.pendingCount).toBe(0);
    expect(sockets).toHaveLength(1);
    expect(client.state).toBe("idle");
  });

  it("cancels a pending reconnect when closed mid-backoff", () => {
    const { client, clock, latest } = setup();
    client.connect();
    latest().open();

    latest().drop();
    expect(clock.pendingCount).toBe(1);

    client.close();
    expect(clock.pendingCount).toBe(0);
  });

  it("applies jitter so peers do not retry in lockstep", () => {
    const sockets: FakeSocket[] = [];
    const clock = fakeClock();
    const client = new SignalingClient({
      url: "ws://test",
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      backoffMs: [1000],
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      random: () => 0, // the low end of the jitter window
    });

    client.connect();
    sockets.at(-1)!.open();
    sockets.at(-1)!.drop();

    expect(clock.lastDelay()).toBe(500);
  });

  it("lets a listener unsubscribe", () => {
    const { client, latest } = setup();
    const received: unknown[] = [];
    const unsubscribe = client.onMessage((m) => received.push(m));

    client.connect();
    latest().open();
    unsubscribe();
    latest().deliver({ type: "member-left", memberId: "ana", reason: "left" });

    expect(received).toEqual([]);
  });
});
