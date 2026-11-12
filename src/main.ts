import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { config, missingKeys } from './config.js';
import { Store } from './db.js';
import { buildDemo, readDemo, type DemoFile } from './demo.js';
import { TavilyProvider } from './search.js';
import { createApp } from './server.js';

const missing = missingKeys();
if (missing.length) console.warn(`\n  Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.\n`);

const llm = new Anthropic({ apiKey: config.anthropicKey || 'missing' });
const search = new TavilyProvider(config.tavilyKey);

// Example history: use the committed file; if there is none, build it once in
// the background with the real agent (about a minute) and keep serving meanwhile.
let demo: DemoFile | null = readDemo(config.demoPath);
let demoStatus: 'ready' | 'building' | 'unavailable' = demo ? 'ready' : 'unavailable';
if (!demo && missing.length === 0) {
  demoStatus = 'building';
  buildDemo({ llm, search }, config.demoPath)
    .then((d) => {
      demo = d;
      demoStatus = 'ready';
      console.log(`[demo] example history written to ${config.demoPath}`);
    })
    .catch((e) => {
      demoStatus = 'unavailable';
      console.warn('[demo] could not build example history:', e instanceof Error ? e.message : e);
    });
}

const app = createApp(
  { store: new Store(config.dbPath), llm, search },
  { demo: () => demo, demoStatus: () => demoStatus },
);

serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, ({ port }) => {
  console.log(`\n  Chat agent running at http://localhost:${port}  (model: ${config.model})\n`);
});
