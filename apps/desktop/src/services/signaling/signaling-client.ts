import type { ClientMessage, ServerMessage } from "@janja/signaling-protocol";

export type SignalingState = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

/** The slice of WebSocket we use, so tests can supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SignalingClientOptions {
  url: string;
  createSocket?: SocketFactory;
  /** Backoff schedule in ms. The last value repeats until maxAttempts. */
  backoffMs?: number[];
  maxAttempts?: number;
  /** Injectable so tests do not wait in real time. */
  setTimeoutFn?: (handler: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
  random?: () => number;
}

type MessageListener = (message: ServerMessage) => void;
type StateListener = (state: SignalingState) => void;

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Owns the WebSocket and nothing else. It knows how to stay connected and how
 * to hand typed messages up; it knows nothing about rooms or WebRTC, which is
 * what lets the sharing and viewing managers share it unchanged.
 */
export class SignalingClient {
  readonly #url: string;
  readonly #createSocket: SocketFactory;
  readonly #backoffMs: number[];
  readonly #maxAttempts: number;
  readonly #setTimeout: (handler: () => void, ms: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #random: () => number;

  readonly #messageListeners = new Set<MessageListener>();
  readonly #stateListeners = new Set<StateListener>();

  #socket: SocketLike | undefined;
  #state: SignalingState = "idle";
  #attempt = 0;
  #reconnectTimer: number | undefined;
  /** Distinguishes a deliberate close from a dropped connection. */
  #shuttingDown = false;

  constructor(options: SignalingClientOptions) {
    this.#url = options.url;
    this.#createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#setTimeout = options.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms) as unknown as number);
    this.#clearTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    this.#random = options.random ?? Math.random;
  }

  get state(): SignalingState {
    return this.#state;
  }

  onMessage(listener: MessageListener): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  connect(): void {
    if (this.#state === "connected" || this.#state === "connecting") return;
    // An explicit connect after giving up is a person deciding to try again,
    // so the attempt counter starts over. Without this the retry gets exactly
    // one shot before the backoff declares failure all over again.
    if (this.#state === "failed") this.#attempt = 0;
    this.#shuttingDown = false;
    this.#open();
  }

  send(message: ClientMessage): void {
    if (!this.#socket || this.#state !== "connected") {
      // Deliberately not queued. A stale offer replayed after a reconnect
      // describes a peer connection that no longer exists.
      throw new Error("signaling socket is not connected");
    }
    this.#socket.send(JSON.stringify(message));
  }

  close(): void {
    this.#shuttingDown = true;
    if (this.#reconnectTimer !== undefined) {
      this.#clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#socket?.close();
    this.#socket = undefined;
    this.#setState("idle");
  }

  #open(): void {
    this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");

    const socket = this.#createSocket(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#setState("connected");
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        // A server that speaks nonsense is a server bug, not a reason to drop
        // a working session.
        return;
      }
      for (const listener of this.#messageListeners) listener(message);
    };

    socket.onclose = () => {
      this.#socket = undefined;
      if (this.#shuttingDown) return;
      this.#scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows, and that is where reconnection is decided.
    };
  }

  #scheduleReconnect(): void {
    this.#attempt += 1;
    if (this.#attempt > this.#maxAttempts) {
      this.#setState("failed");
      return;
    }

    this.#setState("reconnecting");

    const base = this.#backoffMs[Math.min(this.#attempt - 1, this.#backoffMs.length - 1)]!;
    // Jitter keeps six viewers who dropped together from reconnecting in
    // lockstep and hammering the server on the same tick.
    const delay = base * (0.5 + this.#random() * 0.5);

    this.#reconnectTimer = this.#setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#open();
    }, delay);
  }

  #setState(state: SignalingState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}
