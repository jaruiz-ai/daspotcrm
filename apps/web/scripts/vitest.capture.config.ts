import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', include: ['scripts/capture.test.tsx'], testTimeout: 120000, hookTimeout: 120000 } });
