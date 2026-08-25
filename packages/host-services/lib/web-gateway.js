/**
 * Same-origin HTTP gateway for the browser half: the webview-resident client
 * bundle cannot reach third-party APIs (CORS) or the extension-host bridge
 * (different loopback port), so it talks to this plugin's routes on the DSH
 * web carrier instead. Node-side fetches have neither restriction.
 *
 * Routes (all loopback-bound with the rest of the carrier):
 * - GET  /dsh-cline/models          proxy the Shengsuanyun model catalog
 * - GET  /dsh-cline/catalog         the pi-ai builtin catalog's provider → model-id map
 * - POST /dsh-cline/open-external   open a URL in the system browser (bridge)
 * - GET  /dsh-cline/vscode-config   read one dsh-cline setting (bridge)
 * - POST /dsh-cline/vscode-config   write one dsh-cline setting (bridge)
 * - GET  /dsh-cline/mcp             read the MCP server declarations (file)
 * - POST /dsh-cline/mcp             write the MCP server declarations (file)
 * - POST /dsh-cline/restart         restart the DSH service via the bridge
 *
 * @module @dsh-cline/host-services/web-gateway
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mcpConfigFile, validateMcpDocument } from './mcp-loader.js';
/** Shengsuanyun OpenAI-compatible model catalog; public, no auth required. */
const MODELS_URL = 'https://router.shengsuanyun.com/api/v1/models/';
/** Catalog cache lifetime: pricing/roster churn is slow, refresh lazily. */
const MODELS_CACHE_MS = 5 * 60_000;
/** One gateway RPC budget. */
const GATEWAY_TIMEOUT_MS = 15_000;
/** Cached catalog response. */
let modelsCache;
/** Read the request body as JSON, size-capped. */
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024)
            throw new Error('request body too large');
        chunks.push(chunk);
    }
    if (chunks.length === 0)
        return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
/** Fetch the catalog through the short cache. */
async function fetchModels() {
    if (modelsCache !== undefined && Date.now() - modelsCache.at < MODELS_CACHE_MS) {
        return modelsCache.body;
    }
    const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
    if (!response.ok)
        throw new Error('shengsuanyun models HTTP ' + String(response.status));
    const body = await response.text();
    modelsCache = { at: Date.now(), body };
    return body;
}
/**
 * Mount the gateway routes. The bridge-dependent routes answer 503 when no
 * VS Code host launched this process (plain `dsh web`); the catalog proxy is
 * bridge-independent and always serves.
 * @param ctx - plugin context (logging).
 * @param webServer - the DSH web carrier service.
 * @param bridge - the vscodeHost bridge face, or undefined when dormant.
 */
export function registerWebGateway(ctx, webServer, bridge) {
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-cline/models',
        handler: async (_req, res) => {
            try {
                const body = await fetchModels();
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(body);
            }
            catch (err) {
                sendJson(res, 502, { error: 'shengsuanyun catalog unreachable: ' + String(err) });
            }
        },
    }), 'dsh-cline-host-services: models route');
    // The pi-ai builtin catalog as the browser half needs it: provider → model
    // ids. Resolved from the same installation the adapter itself loads, so the
    // model select can never drift from what the route actually serves.
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-cline/catalog',
        handler: async (_req, res) => {
            try {
                const compat = await import('@earendil-works/pi-ai/dist/compat.js');
                const models = {};
                for (const provider of compat.getProviders()) {
                    try {
                        models[provider] = compat.getModels(provider).map(model => model.id);
                    }
                    catch { /* a provider without models stays absent */ }
                }
                sendJson(res, 200, { models });
            }
            catch (err) {
                sendJson(res, 500, { error: 'catalog unavailable: ' + String(err) });
            }
        },
    }), 'dsh-cline-host-services: catalog route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-cline/open-external',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405).end();
                return;
            }
            if (bridge === undefined) {
                sendJson(res, 503, { error: 'no VS Code bridge (plain dsh web)' });
                return;
            }
            try {
                const { url } = await readJson(req);
                if (typeof url !== 'string' || !/^https?:\/\//.test(url))
                    throw new Error('url must be http(s)');
                const opened = await bridge.call('vscode.browser', 'openExternal', [{ url }]);
                sendJson(res, 200, opened);
            }
            catch (err) {
                sendJson(res, 400, { error: String(err) });
            }
        },
    }), 'dsh-cline-host-services: open-external route');
    const config = async (req, res) => {
        if (bridge === undefined) {
            sendJson(res, 503, { error: 'no VS Code bridge (plain dsh web)' });
            return;
        }
        try {
            if (req.method === 'GET') {
                const key = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? '';
                const value = await bridge.call('vscode.config', 'get', [key]);
                sendJson(res, 200, { key, value });
                return;
            }
            if (req.method === 'POST') {
                const { key, value } = await readJson(req);
                if (typeof key !== 'string' || key === '')
                    throw new Error('key is required');
                await bridge.call('vscode.config', 'update', [key, value]);
                sendJson(res, 200, { key, value });
                return;
            }
            res.writeHead(405).end();
        }
        catch (err) {
            sendJson(res, 400, { error: String(err) });
        }
    };
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-cline/vscode-config',
        handler: (req, res) => { void config(req, res); },
    }), 'dsh-cline-host-services: vscode-config route');
    // MCP declarations live in a file both halves share; the route is
    // bridge-independent so a plain `dsh web` can manage them too. Changes take
    // effect on the next DSH boot (servers mount at startup) - the response says so.
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-cline/mcp',
        handler: async (req, res) => {
            try {
                const file = mcpConfigFile();
                if (req.method === 'GET') {
                    const servers = existsSync(file)
                        ? validateMcpDocument(JSON.parse(readFileSync(file, 'utf8')))
                        : {};
                    sendJson(res, 200, { file, servers, restartRequired: true });
                    return;
                }
                if (req.method === 'POST') {
                    const body = await readJson(req);
                    const servers = validateMcpDocument({ servers: body.servers });
                    mkdirSync(dirname(file), { recursive: true });
                    writeFileSync(file, JSON.stringify({ servers }, undefined, 2) + '\n', 'utf8');
                    sendJson(res, 200, { file, servers, restartRequired: true });
                    return;
                }
                res.writeHead(405).end();
            }
            catch (err) {
                sendJson(res, 400, { error: String(err) });
            }
        },
    }), 'dsh-cline-host-services: mcp route');
    // Restart: answer the browser first, then ask the extension host (over the
    // bridge) to restart the DSH service - the Ctrl+C it sends kills this very
    // process, so the bridge call is fire-and-forget by design.
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-cline/restart',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405).end();
                return;
            }
            if (bridge === undefined) {
                sendJson(res, 503, { error: 'no VS Code bridge (plain dsh web)' });
                return;
            }
            sendJson(res, 200, { restarting: true });
            try {
                await bridge.call('vscode.dsh', 'restart', []);
            }
            catch (err) {
                ctx.logger.warn('dsh-cline restart bridge call failed: ' + String(err));
            }
        },
    }), 'dsh-cline-host-services: restart route');
}
