import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@janja/signaling-protocol";

/**
 * A test-only client that buffers everything the server sends, so a test can
 * assert on messages that arrived before it got round to asking for them.
 */
export class TestClient {
  readonly #socket: WebSocket;
  readonly #inbox: ServerMessage[] = [];
  #waiter: ((message: ServerMessage) => void) | undefined;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (this.#waiter) {
        const resolve = this.#waiter;
        this.#waiter = undefined;
        resolve(message);
      } else {
        this.#inbox.push(message);
      }
    });
    socket.on("close", () => {
      this.#closed = true;
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(message));
  }

  sendRaw(raw: string): void {
    this.#socket.send(raw);
  }

  /** Next message, or a rejection if the server stays silent. */
  next(timeoutMs = 1000): Promise<ServerMessage> {
    const buffered = this.#inbox.shift();
    if (buffered) return Promise.resolve(buffered);

    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        reject(new Error("timed out waiting for a server message"));
      }, timeoutMs);

      this.#waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  /** Asserts the server says nothing at all for a while. */
  async expectSilence(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.#inbox.length > 0) {
      throw new Error(`expected silence but received ${JSON.stringify(this.#inbox)}`);
    }
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.#socket.once("close", () => resolve());
      this.#socket.close();
    });
  }
}
