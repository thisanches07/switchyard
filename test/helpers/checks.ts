import type { DependencyCheck } from "../../src/core/health.js";

export const okCheck = (name: string): DependencyCheck => ({ name, check: async () => {} });

export const failingCheck = (name: string): DependencyCheck => ({
  name,
  check: async () => {
    throw new Error(`${name} unreachable`);
  },
});

/** Never resolves on its own; settles only when aborted. Records whether it saw the abort. */
export const hangingCheck = (name: string) => {
  const state = { aborted: false };
  const check: DependencyCheck = {
    name,
    check: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          state.aborted = true;
          reject(signal.reason);
        });
      }),
  };
  return { check, state };
};
