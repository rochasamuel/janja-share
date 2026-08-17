export interface RateLimitConfig {
  messagesPerSecond: number;
  burst: number;
}

/**
 * A token bucket per connection. Chosen over a fixed window because signaling
 * is genuinely bursty — a peer dumps a dozen ICE candidates in a few
 * milliseconds and that is normal traffic, not abuse.
 */
export class TokenBucket {
  #tokens: number;
  #lastRefill: number;
  readonly #ratePerMs: number;
  readonly #capacity: number;

  constructor(config: RateLimitConfig, now: number = Date.now()) {
    this.#capacity = config.burst;
    this.#tokens = config.burst;
    this.#ratePerMs = config.messagesPerSecond / 1000;
    this.#lastRefill = now;
  }

  /** Consumes one token. False means the caller is over its allowance. */
  tryConsume(now: number = Date.now()): boolean {
    const elapsed = now - this.#lastRefill;
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#ratePerMs);
      this.#lastRefill = now;
    }
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
