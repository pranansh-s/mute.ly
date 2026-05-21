import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@huggingface/transformers': resolve(
        __dirname,
        'node_modules/@huggingface/transformers/dist/transformers.web.js'
      ),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/whisper-worker.ts'),
      formats: ['es'],
      fileName: () => 'whisper-worker.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
