#!/usr/bin/env node

import { executeParsedArgs } from './controller.js';

executeParsedArgs(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}).catch(error => {
    process.stderr.write(`[flow-controller] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
