import { build } from 'esbuild-wasm';
await build({entryPoints:['worker.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/worker.mjs',logLevel:'info'});
