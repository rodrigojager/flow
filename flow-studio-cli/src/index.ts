#!/usr/bin/env node

import { createFlowStudioCli } from './cli';

createFlowStudioCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`[flow] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
