import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  logLevel: 'info',
  legalComments: 'none',
};

const entries = [
  { entryPoints: ['src/content.ts'], outfile: 'dist/content.js' },
  { entryPoints: ['src/popup.ts'], outfile: 'dist/popup.js' },
];

const watch = process.argv.includes('--watch');

for (const e of entries) {
  const opts = { ...common, ...e };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log(`watching ${e.entryPoints[0]}`);
  } else {
    await esbuild.build(opts);
  }
}
