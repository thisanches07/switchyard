import type { GatewayError } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";

/** A provider that always fails with a fixed gateway error (not implemented / not configured). */
export function createFailingProvider(
  name: string,
  type: string,
  error: () => GatewayError,
): ChatProvider {
  return {
    name,
    type,
    async chat() {
      throw error();
    },
  };
}
