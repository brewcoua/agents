// Shared by the extensions that run an in-process session (btw, agents). Not an extension.

import { fileURLToPath } from "node:url"
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent"

// Loaded into every in-process session, so its tools obey the same path rules. Such a session has
// no UI, so what guardrails would ask about is refused.
export const GUARDRAILS = fileURLToPath(new URL("../guardrails/index.ts", import.meta.url))

type Model = NonNullable<ExtensionContext["model"]>

// A provider registered by an extension (claude-bridge) exists only in the main runtime; the new
// session gets a runtime that has it. Undefined means the default runtime will do.
export async function runtimeFor(ctx: ExtensionContext, model: Model): Promise<ModelRuntime | undefined> {
  const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider)
  const native = ctx.modelRegistry.getRegisteredNativeProvider(model.provider)
  if (!config && !native) return undefined
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false })
  if (native) modelRuntime.registerNativeProvider(native)
  else if (config) modelRuntime.registerProvider(model.provider, config)
  await modelRuntime.refresh({ allowNetwork: false })
  return modelRuntime
}
