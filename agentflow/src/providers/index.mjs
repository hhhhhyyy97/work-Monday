import { CodexProvider } from "./codex.mjs";
import { MockProvider } from "./mock.mjs";
import { PiProvider } from "./pi.mjs";

export function createProvider(name) {
  if (name === "mock") return new MockProvider();
  if (name === "codex") return new CodexProvider();
  if (name === "pi") return new PiProvider();
  throw new Error(`Unsupported provider: ${name}. Use codex, pi, or mock.`);
}
