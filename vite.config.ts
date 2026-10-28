import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [wgslVitePlugin()],
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 100_000 },
});
