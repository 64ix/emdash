import { resolve } from 'node:path';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { defineConfig } from 'vite';

const root = resolve(__dirname, 'src');

export default defineConfig({
  resolve: {
    alias: {
      '@': root,
      '@react': resolve(root, 'react'),
      '@styles': resolve(root, 'styles'),
      '@theme': resolve(root, 'theme'),
    },
  },
  plugins: [vanillaExtractPlugin()],
});
