import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', include: ['src/**/*.test.tsx'], testTimeout: 60000, hookTimeout: 60000 } });
