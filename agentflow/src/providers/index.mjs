import { CodexProvider } from "./codex.mjs";
import { MockProvider } from "./mock.mjs";
import { PiProvider } from "./pi.mjs";

export function createProvider(name) {
  if (name === "mock") return new MockProvider();
  if (name === "codex") return new CodexProvider();
  if (name === "pi") return new PiProvider();
  throw new Error(`不支持的 Provider：${name}。请使用 codex、pi 或 mock。`);
}
