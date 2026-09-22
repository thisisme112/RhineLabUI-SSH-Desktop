/** The terminal now uses the shared pre-entry inspection surface. */
process.argv.push('--inspection');
if (!process.argv.includes('--out')) process.argv.push('--out', 'verification/terminal-teardown');
await import('./check-terminal-deck.mjs');
