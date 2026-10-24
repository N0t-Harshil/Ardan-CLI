#!/usr/bin/env node
// Ardan launcher. Requires Node >= 24 (built-in TypeScript type stripping).
const major = parseInt(process.versions.node.split('.')[0], 10);
if (Number.isNaN(major) || major < 24) {
  console.error('ardan requires Node.js >= 24 (found ' + process.versions.node + ').');
  console.error('Install Node 24+: https://nodejs.org  (winget install OpenJS.NodeJS)');
  process.exit(1);
}
try {
  await import(new URL('../src/cli.ts', import.meta.url));
} catch (error) {
  if (
    error &&
    error.code === 'ERR_UNKNOWN_FILE_EXTENSION' &&
    major === 24
  ) {
    console.error('Trailing-edge Node build detected. Re-run with:');
    console.error('  node --experimental-strip-types ' + new URL('../src/cli.ts', import.meta.url).pathname);
    process.exit(1);
  }
  throw error;
}
