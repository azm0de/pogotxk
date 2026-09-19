/**
 * Stops the built Astro entry from crashing the run on import.
 *
 * `es-module-lexer` ships its parser as a base64 blob and initialises it at
 * module scope with `WebAssembly.compile(bytes).then(...)`. Astro's Actions
 * runtime pulls it in, so it lands in `dist/server/entry.mjs` whether or not
 * this app uses Actions — and workerd refuses to compile WebAssembly from bytes
 * at runtime ("Wasm code generation disallowed by embedder"), in production
 * exactly as here. Nobody awaits that promise, so on the deployed Worker the
 * rejection is simply lost; under Vitest it surfaces as an unhandled rejection
 * and fails the whole run with no failing test to point at.
 *
 * Nothing in this app needs WebAssembly, so the fix is to hand that one call a
 * promise that never settles: the `.then` chain behind it never runs and never
 * rejects. It is installed only for as long as the app's module graph is being
 * evaluated — `test/setup.ts` restores the real function immediately after.
 */

const realCompile = WebAssembly.compile;

export function stubWebAssemblyCompile(): void {
  WebAssembly.compile = () => new Promise<WebAssembly.Module>(() => {});
}

export function restoreWebAssemblyCompile(): void {
  WebAssembly.compile = realCompile;
}

stubWebAssemblyCompile();
