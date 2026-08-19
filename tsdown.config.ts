import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'es2024',
  outDir: 'lib',
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  clean: true,
})
