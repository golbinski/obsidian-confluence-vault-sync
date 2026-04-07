import esbuild from 'esbuild';

const dev = process.argv[2] === 'dev';

const context = await esbuild.context({
  entryPoints: ['main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', 'codemirror', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: dev ? 'inline' : false,
  treeShaking: true,
  outfile: 'main.js',
  platform: 'node',
});

if (dev) {
  await context.watch();
} else {
  await context.rebuild();
  process.exit(0);
}
