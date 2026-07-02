import { defineConfig } from 'vite';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: {
        content: resolve(__dirname, 'src/content.ts'),
        background: resolve(__dirname, 'src/background.ts'),
        offscreen: resolve(__dirname, 'src/offscreen.ts'),
      },
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: false,
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'public/manifest.json',
          dest: '.',
        },
        {
          src: 'public/index.html',
          dest: '.',
        },
        {
          src: 'public/icons/*',
          dest: 'icons',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/*.wasm',
          dest: 'assets',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/*.mjs',
          dest: 'assets',
        },
        {
          src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',
          dest: 'assets',
        },
        {
          src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx',
          dest: 'assets',
        },
        {
          src: 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
          dest: 'assets',
        },
      ],
    }),
  ],
});
