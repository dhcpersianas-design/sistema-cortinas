import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Todos os arquivos usam o mesmo banco de teste: rodar um de cada vez.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
