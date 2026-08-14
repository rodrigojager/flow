'use strict';

const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { createStandaloneProviderAdapter } = require('../lib/native-provider');
const { FlowProviderBroker, mergeProviderCatalogs } = require('../lib/provider-broker');
const { FlowStandaloneProviderService } = require('../lib/standalone-provider');

const rawCatalog = {
    standalone: {
        id: 'standalone',
        name: 'Standalone Test',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://example.test/v1',
        env: ['STANDALONE_TEST_KEY'],
        models: {
            'test-model': {
                id: 'test-model', name: 'Test Model', family: 'test', release_date: '2026-08-10',
                attachment: false, reasoning: true, tool_call: true,
                limit: { context: 100000, output: 4096 }, cost: { input: 1, output: 2 },
                modalities: { input: ['text'], output: ['text'] }
            }
        }
    }
};

const catalogFetcher = async () => new Response(JSON.stringify(rawCatalog), { status: 200, headers: { 'content-type': 'application/json' } });

test('loads a standalone catalog and encrypts credentials without any provider host CLI', async t => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-standalone-store-'));
    t.after(() => fs.rm(configRoot, { recursive: true, force: true }));
    const service = new FlowStandaloneProviderService({ configRoot, fetcher: catalogFetcher, catalogTtlMs: 60_000 });

    const before = await service.catalog();
    assert.equal(before.source, 'flow');
    assert.equal(before.providers[0].models[0].reference, 'standalone/test-model');
    assert.equal(before.providers[0].connected, false);

    await service.setApiKey('standalone', 'MUST_STAY_ENCRYPTED', { baseURL: 'https://example.test/v1', headers: '{"X-Project":"demo"}', protocol: 'openai' });
    const storedText = await fs.readFile(path.join(configRoot, 'credentials.json'), 'utf8');
    assert.doesNotMatch(storedText, /MUST_STAY_ENCRYPTED|X-Project|demo/);
    const credential = await service.credential('standalone');
    assert.equal(credential.apiKey, 'MUST_STAY_ENCRYPTED');
    assert.equal(credential.baseURL, 'https://example.test/v1');
    assert.deepEqual(credential.headers, { 'X-Project': 'demo' });
    assert.equal(credential.protocol, 'openai');
    assert.equal((await service.catalog()).providers[0].connected, true);
});

test('FlowProviderBroker works in flow-only mode and merges optional host metadata in parallel', async t => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-standalone-broker-'));
    t.after(() => fs.rm(configRoot, { recursive: true, force: true }));
    const broker = new FlowProviderBroker({ workspaceRoot: process.cwd(), preferredHost: 'flow', standalone: { configRoot, fetcher: catalogFetcher } });
    const catalog = await broker.catalog();
    assert.equal(catalog.source, 'flow');
    assert.equal(catalog.providers[0].id, 'standalone');
    const hosted = {
        source: 'cybervinci', sources: ['cybervinci'], connected: ['standalone'],
        providers: [{ ...catalog.providers[0], connected: true, connectedSources: ['cybervinci'], sources: ['cybervinci'], authMethods: [{ type: 'oauth', label: 'Browser', method: 2, source: 'cybervinci' }] }]
    };
    const merged = mergeProviderCatalogs(catalog, hosted);
    assert.deepEqual(merged.sources, ['flow', 'cybervinci']);
    assert.deepEqual(merged.providers[0].connectedSources, ['cybervinci']);
    assert.ok(merged.providers[0].authMethods.some(method => method.type === 'api' && method.source === 'flow'));
    assert.ok(merged.providers[0].authMethods.some(method => method.type === 'oauth' && method.method === 2));
});

test('executes an OpenAI-compatible model directly from the Flow credential store', async t => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-native-provider-'));
    t.after(() => fs.rm(configRoot, { recursive: true, force: true }));
    let requestRecord;
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requestRecord = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{ message: { content: '{"output":{"result":"FLOW_STANDALONE_OK"},"summary":"native"}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 }
        }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const address = server.address();
    const service = new FlowStandaloneProviderService({ configRoot, fetcher: catalogFetcher });
    await service.setApiKey('standalone', 'standalone-secret', { baseURL: `http://127.0.0.1:${address.port}/v1` });
    const adapter = createStandaloneProviderAdapter(service);
    const result = await adapter({
        node: { id: 'agent', type: 'agent', label: 'Agent', prompt: 'smoke', outputs: { result: 'result' } },
        graph: { version: 'flow-studio/v2', id: 'standalone-smoke', name: 'Standalone smoke', start: 'agent', nodes: [], edges: [] },
        runId: 'run-1', context: {}, input: { request: 'smoke' }, prompt: 'Return the marker',
        runner: { runnerId: 'flow', providerId: 'standalone', modelId: 'standalone/test-model', reasoningEffort: 'medium' },
        model: { id: 'standalone/test-model', name: 'Test', providerId: 'standalone', runnerId: 'flow', modelId: 'standalone/test-model' }
    });
    assert.equal(result.output.result, 'FLOW_STANDALONE_OK');
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(requestRecord.url, '/v1/chat/completions');
    assert.equal(requestRecord.authorization, 'Bearer standalone-secret');
    assert.equal(requestRecord.body.model, 'test-model');
});
