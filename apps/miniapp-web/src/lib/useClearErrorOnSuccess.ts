import { useEffect } from "react";
import { subscribeApiOk } from "./api";

/**
 * Clears a screen's error banner the moment any request succeeds again.
 *
 * Without it the banner is write-once: one failed call paints it red and
 * nothing ever repaints it. A foreman who caught the server mid-restart kept
 * looking at "Request failed: 502" long after everything worked again, with no
 * way to tell whether it was still broken.
 */
export function useClearErrorOnSuccess(setError: (value: null) => void) {
  useEffect(() => subscribeApiOk(() => setError(null)), [setError]);
}
