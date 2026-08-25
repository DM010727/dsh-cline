/**
 * Selection-actions injector: turns a VS Code "用 DSH Cline 解释/优化" or
 * "添加到 DSH Cline" context-menu action into a DSH conversation turn.
 *
 * The extension builds a prompt (selected code + file mention + diagnostics),
 * expands @-mentions, and POSTs it to this plugin's `/dsh-cline/task` route.
 * The plugin injects the prompt into the DSH session the user is CURRENTLY
 * looking at (the frontend-subscribed session), so the reply streams into the
 * conversation they're viewing — Cline's "show result in the chat" behavior,
 * not a detached one-shot.
 *
 * To know which session is current, the plugin observes the DSH event bus with
 * `global: true` (bypassing agent-context filtering) and records the most recent
 * session id seen from session/turn/user activity. The frontend-subscribed
 * session is the one emitting these, so the last-seen id is the active
 * conversation. If none is known yet, the route answers a clear error instead
 * of guessing (an orphan session's reply would never be seen by the user).
 *
 * @module @dsh-cline/host-services/task-injector
 */
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
/** The persistent-session id the frontend is currently subscribed to. */
let currentSessionId;
/** Best-effort pull of a session id from a `session/event`-style subject. */
function sessionIdOf(subject) {
    if (subject === null || typeof subject !== 'object')
        return undefined;
    const s = subject;
    const id = s.id ?? s.sessionId;
    return typeof id === 'string' && id !== '' ? id : undefined;
}
/** Track the active session from DSH's session/turn/user events (global: true). */
function trackActiveSession(ctx) {
    const events = ctx;
    const g = { global: true };
    events.on('session/event', (subject, _event) => {
        const id = sessionIdOf(subject);
        if (id !== undefined)
            currentSessionId = id;
    }, g);
    events.on('turn/start', (subject) => {
        const id = sessionIdOf(subject);
        if (id !== undefined)
            currentSessionId = id;
    }, g);
    events.on('user/message', (subject) => {
        const id = sessionIdOf(subject);
        if (id !== undefined)
            currentSessionId = id;
    }, g);
}
/**
 * Register the selection-action task route.
 * @param ctx - plugin context owning the web carrier and agent registry.
 * @param webServer - the web carrier the route mounts on.
 */
export function registerTaskInjector(ctx, webServer) {
    trackActiveSession(ctx);
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-cline/task',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405).end();
                return;
            }
            let body;
            try {
                body = await readJson(req);
            }
            catch (err) {
                sendJson(res, 400, { ok: false, error: 'bad request body: ' + String(err) });
                return;
            }
            if (typeof body.content !== 'string' || body.content === '') {
                sendJson(res, 400, { ok: false, error: 'content is required' });
                return;
            }
            // Prefer an explicit session id the extension learned; else the tracked
            // frontend-subscribed session.
            const sessionId = typeof body.sessionId === 'string' && body.sessionId !== ''
                ? body.sessionId
                : currentSessionId;
            const agents = ctx.get('agents');
            const agent = sessionId !== undefined ? agents?.get(sessionId) : undefined;
            if (agent === undefined || agent === null) {
                // No live session (user never opened one). Create a fresh one and inject
                // there; the extension opens the DSH panel so it becomes visible. Mirrors
                // the DSH headless runner's agents.create usage.
                const created = await createTaskSession(ctx, body.content, body.cwd);
                if (created === undefined) {
                    sendJson(res, 409, { ok: false, error: 'no current DSH session known; open one in DSH and retry' });
                    return;
                }
                sendJson(res, 200, { ok: true, sessionId: created, created: true });
                return;
            }
            try {
                agent.followup(createUserMessage({
                    content: [{ type: 'text', text: body.content }],
                    source: { kind: 'user' },
                }));
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: 'inject failed: ' + String(err) });
                return;
            }
            sendJson(res, 200, { ok: true, sessionId });
        },
    }), 'dsh-cline-host-services: task route');
}
/** Create a fresh agent + session and inject the prompt, mirroring dsh-headless. */
async function createTaskSession(ctx, content, cwd) {
    const agents = ctx.get('agents');
    const defaultModel = ctx.get('agentDefaultModel');
    const sessions = ctx.get('sessions');
    if (agents === undefined || defaultModel === undefined)
        return undefined;
    const workdir = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    const selection = defaultModel.currentSelection();
    const sessionId = 'session-' + randomUUID();
    try {
        const { agent, session } = await agents.create({
            sessionId: SessionId(sessionId),
            meta: { cwd: workdir },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => installModelSelection(agentCtx, {
                current: selection,
                assembled: undefined,
            }),
        });
        agent.followup(createUserMessage({
            content: [{ type: 'text', text: content }],
            source: { kind: 'user' },
        }));
        currentSessionId = sessionId;
        void sessions?.flush(session).catch(() => { });
        return sessionId;
    }
    catch (err) {
        ctx.logger.warn('task-injector: create session failed: ' + String(err));
        return undefined;
    }
}
/** Read the request body as JSON, size-capped. */
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > 64 * 1024)
            throw new Error('request body too large');
        chunks.push(buf);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
