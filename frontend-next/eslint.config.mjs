// ESLint flat config. Next 16 removed `next lint`, so `npm run lint` runs the ESLint CLI directly.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  globalIgnores(['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts']),
  {
    rules: {
      // Only console.error is allowed, so a token or user object can't be logged by accident.
      'no-console': ['error', { allow: ['error'] }],
    },
  },
]);
