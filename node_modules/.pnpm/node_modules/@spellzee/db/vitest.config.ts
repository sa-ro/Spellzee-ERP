import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Testcontainers pulls and boots a real Postgres; the first run is slow.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Migrations and shared fixtures make parallel files unsafe.
    fileParallelism: false,
  },
});
