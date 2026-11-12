import { randomUUID } from 'node:crypto';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { config, missingKeys } from './config.js';
import { runAgent, type AgentDeps } from './agent/run.js';
import { loadDemo, type DemoFile } from './demo.js';
import { extractMemory } from './memory/extract.js';
import { RateLimiter } from './ratelimit.js';
import { isValidTimeZone } from './time.js';

type Env = { Variables: { userId: string } };

export interface AppOptions {
  /** Current example history; a function because it may finish building after boot. */
  demo?: () => DemoFile | null;
  demoStatus?: () => 'ready' | 'building' | 'unavailable';
}

const VISITOR_COOKIE = 'vid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createApp(deps: AgentDeps, opts: AppOptions = {}) {
  const app = new Hono<Env>();
  const perVisitor = new RateLimiter(config.messagesPerHourPerVisitor, 3_600_000);
  const perIp = new RateLimiter(config.messagesPerHourPerIp, 3_600_000);
  const global = new RateLimiter(config.messagesPerDay, 86_400_000);

  app.get('/healthz', (c) => c.text('ok'));

  // Anonymous identity: one random id per browser, in an httpOnly cookie.
  // Memory is scoped to it, so visitors of a shared demo link never see each other's chats.
  app.use('/api/*', async (c, next) => {
    let id = getCookie(c, VISITOR_COOKIE);
    if (!id || !UUID.test(id)) {
      id = randomUUID();
      setCookie(c, VISITOR_COOKIE, id, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    c.set('userId', id);
    await next();
  });

  const limited = (c: Context<Env>, cost = 1): Response | null => {
    for (let i = 0; i < cost; i++) {
      const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'local';
      const wait = perVisitor.hit(c.get('userId')) || perIp.hit(ip) || global.hit('all');
      if (wait) {
        return c.json({ error: `You've hit the demo's message limit. Try again in ${Math.ceil(wait / 60)} min.` }, 429);
      }
    }
    return null;
  };

  app.get('/api/config', (c) =>
    c.json({
      missingKeys: missingKeys(),
      allowClockOverride: config.allowClockOverride,
      model: config.model,
      demo: opts.demoStatus?.() ?? 'unavailable',
    }),
  );

  // What the agent has learned about this visitor. Visible and deletable by design.
  app.get('/api/profile', (c) => c.json(deps.store.getProfile(c.get('userId'))));
  app.delete('/api/profile/:key', (c) => {
    deps.store.deleteProfile(c.get('userId'), decodeURIComponent(c.req.param('key')));
    return c.body(null, 204);
  });

  app.get('/api/threads', (c) => c.json(deps.store.listThreads(c.get('userId'))));

  app.get('/api/threads/:id', (c) => c.json(deps.store.threadTurns(c.get('userId'), c.req.param('id'), 200)));

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ threadId?: string; message?: string; tz?: string; now?: string }>();
    const message = body.message?.trim();
    if (!message) return c.json({ error: 'message is required' }, 400);
    if (message.length > 8000) return c.json({ error: 'message is too long (max 8000 characters)' }, 400);
    const tz = isValidTimeZone(body.tz) ? body.tz : 'UTC';
    const nowMs = resolveNow(body.now);
    if (nowMs === null) return c.json({ error: 'now must be an ISO date-time' }, 400);
    const blocked = limited(c);
    if (blocked) return blocked;
    const userId = c.get('userId');

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      for await (const ev of runAgent(deps, { userId, threadId: body.threadId, message, nowMs, tz, signal: abort.signal })) {
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    });
  });

  // Copies the example chats into this visitor's memory, dated relative to their today.
  app.post('/api/demo', async (c) => {
    const demo = opts.demo?.();
    if (!demo) return c.json({ error: 'Example history is not ready yet. Try again in a minute.' }, 503);
    const body = await c.req.json<{ tz?: string; now?: string }>().catch(() => ({}) as { tz?: string; now?: string });
    const tz = isValidTimeZone(body.tz) ? body.tz : 'UTC';
    const nowMs = resolveNow(body.now) ?? Date.now();
    return c.json({ added: loadDemo(deps.store, c.get('userId'), demo, nowMs, tz) });
  });

  // Seed your own past conversations, e.g. "on 3 November I asked you…".
  // Body: [{ at: ISO, user: string, assistant: string, tz? }]. Scoped to the caller.
  app.post('/api/history', async (c) => {
    const items = await c.req.json<{ at: string; user: string; assistant: string; tz?: string }[]>();
    if (!Array.isArray(items) || items.length > 20) return c.json({ error: 'expected an array of at most 20 items' }, 400);
    const blocked = limited(c, items.length);
    if (blocked) return blocked;
    const userId = c.get('userId');
    const ids: number[] = [];
    for (const it of items) {
      const at = Date.parse(it.at);
      if (Number.isNaN(at) || !it.user || !it.assistant) return c.json({ error: `bad item: ${JSON.stringify(it)}` }, 400);
      const thread = deps.store.ensureThread(userId, undefined, it.user, at);
      const turn = {
        userId,
        threadId: thread.id,
        createdAt: at,
        tz: isValidTimeZone(it.tz) ? it.tz : 'UTC',
        userText: it.user,
        assistantText: it.assistant,
        sources: [],
        queries: [],
      };
      const id = deps.store.addTurn(turn);
      ids.push(id);
      extractMemory(deps.llm, deps.store, { ...turn, id }).catch(() => {});
    }
    return c.json({ imported: ids.length, turnIds: ids });
  });

  // Browser libraries are served from node_modules: no CDN, no build step.
  const vendor: Record<string, string> = {
    '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js',
    '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
  };
  for (const [route, file] of Object.entries(vendor)) app.get(route, serveStatic({ path: `./${file}` }));
  app.use('/*', serveStatic({ root: './public' }));
  return app;
}

function resolveNow(override: string | undefined): number | null {
  if (!override || !config.allowClockOverride) return Date.now();
  const ms = Date.parse(override);
  return Number.isNaN(ms) ? null : ms;
}
