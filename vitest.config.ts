import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
        },
      },
      'app/vitest.config.ts',
    ],
  },
});
