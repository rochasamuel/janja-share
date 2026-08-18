import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../config.js";
import {
  SignalingClient,
  type SignalingState,
} from "../services/signaling/signaling-client.js";

/**
 * One signaling connection for the life of the app, held in a ref.
 *
 * The client must not live in React state: a re-render that replaced it would
 * drop the socket and, with it, every peer connection being negotiated over
 * that socket.
 */
export function useSignaling(): {
  client: SignalingClient | null;
  state: SignalingState;
  /** Manual retry, for when the backoff has given up entirely. */
  retry: () => void;
} {
  const clientRef = useRef<SignalingClient | null>(null);
  const [state, setState] = useState<SignalingState>("idle");

  if (clientRef.current === null) {
    clientRef.current = new SignalingClient({ url: config.signalingUrl });
  }

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    const unsubscribe = client.onStateChange(setState);
    client.connect();

    return () => {
      unsubscribe();
      client.close();
    };
  }, []);

  const retry = useCallback(() => clientRef.current?.connect(), []);

  return { client: clientRef.current, state, retry };
}
