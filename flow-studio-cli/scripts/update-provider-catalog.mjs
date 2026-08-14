import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';

const source = process.env.FLOW_MODELS_URL || 'https://models.dev/api.json';
const target = path.resolve('src/provider-catalog.snapshot.json.gz');
const response = await fetch(source, {
    headers: { 'User-Agent': 'flow-cli/catalog-builder' },
    signal: AbortSignal.timeout(30_000)
});
if (!response.ok) throw new Error(`Catalog source returned ${response.status}.`);
const catalog = await response.json();
if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Catalog source returned an invalid document.');

let providers = 0;
let models = 0;
for (const value of Object.values(catalog)) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.models || typeof value.models !== 'object') continue;
    providers += 1;
    models += Object.keys(value.models).length;
}
if (providers < 50 || models < 500) throw new Error(`Catalog is unexpectedly small (${providers} providers, ${models} models).`);

const payload = JSON.stringify({
    schema: 'flow-provider-catalog/v1',
    source,
    generatedAt: new Date().toISOString(),
    providers: catalog
});
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, gzipSync(payload, { level: 9 }));
process.stdout.write(`Wrote ${target}: ${providers} providers, ${models} models.\n`);
