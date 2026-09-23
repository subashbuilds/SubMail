// Bridge between the test runtime and the application's Env type.
//
// @cloudflare/vitest-pool-workers >= 0.22 types the `env` binding from
// "cloudflare:test" as `Cloudflare.Env` — the augmentation interface for the
// Workers runtime's typed-env feature (declared empty by
// @cloudflare/workers-types, which documents extending it from
// project-specific files). This file merges the application's `Env` into that
// global interface, so tests can pass `env` from "cloudflare:test" directly
// to application functions typed with the app's own `Env`.
//
// Compile-time only (a .d.ts); nothing is emitted at runtime.
import type { Env as AppEnv } from "../src/types/index.js";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }
}

export {};
