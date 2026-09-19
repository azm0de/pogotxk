// `cloudflare:test` is declared by the pool rather than by the runtime types,
// and tsconfig.json pins `types` to a closed list, so nothing would pick this
// up implicitly.
/// <reference types="@cloudflare/vitest-pool-workers/types" />
