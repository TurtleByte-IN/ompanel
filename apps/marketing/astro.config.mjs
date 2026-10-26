import { defineConfig } from "astro/config";

// Astro loads env with an empty prefix, and under `vp run` Vite+'s loadEnv then reports every
// variable to the task cache. Any env difference (TERM, VP_RAW_SUBCOMMAND, an agent's session
// vars) would rerun `astro check`. Without the runner client, loadEnv reads process.env directly;
// file tracking does not use this client.
delete process.env.VP_RUN_NODE_CLIENT_PATH;

export default defineConfig({
  // No `site` until Ompanel has a hosted domain (blocker B-003); Layout.astro omits canonical and
  // social-card tags without it.
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
