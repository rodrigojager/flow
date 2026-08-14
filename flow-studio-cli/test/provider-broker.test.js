'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const {
    catalogModelProfile,
    FlowProviderBroker,
    normalizeProviderCatalog
} = require('../lib/provider-broker');

const rawCatalog = {
    connected: ['openai'],
    default: { openai: 'gpt-test', openrouter: 'vendor/model' },
    all: [
        {
            id: 'openai',
            name: 'OpenAI',
            env: ['OPENAI_API_KEY'],
            options: { apiKey: 'MUST_NOT_LEAK' },
            models: {
                'gpt-test': {
                    id: 'gpt-test',
                    name: 'GPT Test',
                    family: 'gpt',
                    status: 'active',
                    release_date: '2026-08-10',
                    capabilities: { reasoning: true, toolcall: true, attachment: true, input: { image: true, pdf: true } },
                    cost: { input: 1.25, output: 5 },
                    limit: { context: 500000, output: 128000 },
                    variants: { low: {}, high: {}, xhigh: {} }
                }
            }
        },
        {
            id: 'openrouter',
            name: 'OpenRouter',
            env: ['OPENROUTER_API_KEY'],
            models: [{ id: 'vendor/model', name: 'Vendor Model', capabilities: {}, cost: { input: 0, output: 0 }, limit: {} }]
        }
    ]
};

const rawAuth = {
    openai: [
        { type: 'oauth', label: 'ChatGPT browser' },
        { type: 'api', label: 'API key' }
    ],
    azure: [{ type: 'api', label: 'API key', prompts: [{ type: 'text', key: 'resourceName', message: 'Resource', placeholder: 'name' }] }]
};

test('normalizes the CyberVinci catalog without exposing provider secrets', () => {
    const catalog = normalizeProviderCatalog(rawCatalog, rawAuth, 'cybervinci');
    assert.equal(catalog.source, 'cybervinci');
    assert.equal(catalog.providers.length, 2);
    assert.equal(catalog.providers[0].connected, true);
    assert.equal(catalog.providers[0].models[0].reference, 'openai/gpt-test');
    assert.deepEqual(catalog.providers[0].models[0].variants, ['low', 'high', 'xhigh']);
    assert.doesNotMatch(JSON.stringify(catalog), /MUST_NOT_LEAK/);
});

test('converts a discovered model into a CyberVinci runner profile', () => {
    const catalog = normalizeProviderCatalog(rawCatalog, rawAuth, 'cybervinci');
    const provider = catalog.providers.find(item => item.id === 'openai');
    const profile = catalogModelProfile(catalog.source, provider, provider.models[0]);
    assert.equal(profile.id, 'openai/gpt-test');
    assert.equal(profile.modelId, 'openai/gpt-test');
    assert.equal(profile.runnerId, 'cybervinci');
    assert.equal(profile.reasonDefault, 'high');
    assert.ok(profile.capabilities.includes('tools'));
    assert.ok(profile.capabilities.includes('vision'));
});

test('forwards credentials and OAuth to the local provider host without returning the key', async t => {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : undefined });
        response.setHeader('content-type', 'application/json');
        if (request.url.startsWith('/provider/auth')) return response.end(JSON.stringify(rawAuth));
        if (request.url.startsWith('/provider/openai/oauth/authorize')) return response.end(JSON.stringify({ url: 'https://example.test/login', method: 'code', instructions: 'Paste code' }));
        if (request.url.startsWith('/provider/openai/oauth/callback')) return response.end('true');
        if (request.url.startsWith('/provider')) return response.end(JSON.stringify(rawCatalog));
        response.end('true');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const address = server.address();
    const broker = new FlowProviderBroker({ workspaceRoot: process.cwd(), baseUrl: `http://127.0.0.1:${address.port}` });

    const catalog = await broker.catalog();
    assert.equal(catalog.providers[0].id, 'openai');
    await broker.setApiKey('openai', 'top-secret', { account: 'primary' });
    const authorization = await broker.authorize('openai', 0, { deployment: 'public' });
    assert.equal(authorization.url, 'https://example.test/login');
    await broker.callback('openai', 0, 'authorization-code');

    const keyRequest = requests.find(item => item.method === 'PUT');
    assert.deepEqual(keyRequest.body, { type: 'api', key: 'top-secret', metadata: { account: 'primary' } });
    assert.doesNotMatch(JSON.stringify(catalog), /top-secret/);
    assert.deepEqual(requests.find(item => item.url.startsWith('/provider/openai/oauth/callback')).body, { method: 0, code: 'authorization-code' });
});
