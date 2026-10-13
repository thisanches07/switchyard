import type { OutcomeRecorder } from "../../core/usage.js";

/** Accepts and discards events (the default when nothing consumes them). */
export const noopRecorder: OutcomeRecorder = { record() {} };

/**
 * Delivers each event to every recorder in order (e.g. budget counters and the publisher,
 * spec 007). A failing recorder does not stop the others; the first error is rethrown after.
 */
export function fanOut(...recorders: OutcomeRecorder[]): OutcomeRecorder {
  return {
    record(event) {
      const errors: unknown[] = [];
      for (const recorder of recorders) {
        try {
          recorder.record(event);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
  };
}
