import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers >= 0.22 (vitest 4) expresses its configuration as a
// Vite plugin: the former `test.poolOptions.workers` object becomes the
// plugin's argument, and the rest of the `test` options stay standard Vitest.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // All real configuration lives under [env.production.*] — see
      // wrangler.toml — so the test runtime must resolve that environment.
      wrangler: { configPath: "./wrangler.toml", environment: "production" },
      miniflare: {
        d1Databases: ["DB"],
        // Local R2 test bucket: attachment storage runs through the b2.ts
        // test seam against this binding, so tests need no B2 credentials
        // and no network. Production has no such binding and uses B2.
        r2Buckets: ["ATTACHMENTS"],
        // Non-secret B2 placeholders — required by Env typing; unused as
        // long as the ATTACHMENTS test binding exists.
        bindings: { B2_KEY_ID: "test-key-id", B2_APPLICATION_KEY: "test-key", B2_REGION: "us-east-005", B2_BUCKET: "submail-attachments" },
      },
    }),
  ],
  test: {
    globals: true,
  },
});
