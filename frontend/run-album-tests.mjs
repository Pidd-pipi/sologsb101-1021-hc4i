import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const result = await build({
  entryPoints: ['scripts/test-album-layout.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
});
const code = result.outputFiles[0].text;
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
await import(dataUrl);
