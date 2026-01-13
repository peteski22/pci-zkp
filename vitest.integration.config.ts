import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60000, // Integration tests may take longer
    hookTimeout: 30000,
    // Run sequentially - network tests may conflict
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
