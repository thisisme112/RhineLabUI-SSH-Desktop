import { artifactPath } from "../lib/artifacts.mjs";
/** The terminal now uses the shared pre-entry inspection surface. */
process.argv.push('--inspection');
if (!process.argv.includes('--out')) process.argv.push('--out', artifactPath('terminal-teardown'));
await import('./check-terminal-deck.mjs');
