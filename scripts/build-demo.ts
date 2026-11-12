// Regenerates demo/history.json with the real model and search APIs.
//   npm run demo:build
import Anthropic from '@anthropic-ai/sdk';
import { config, missingKeys } from '../src/config.js';
import { buildDemo } from '../src/demo.js';
import { TavilyProvider } from '../src/search.js';

const missing = missingKeys();
if (missing.length) {
  console.error(`Set ${missing.join(', ')} in .env first.`);
  process.exit(1);
}
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
await buildDemo(
  { llm: new Anthropic({ apiKey: config.anthropicKey }), search: new TavilyProvider(config.tavilyKey) },
  config.demoPath,
  tz,
);
console.log(`Wrote ${config.demoPath}. Commit it so the deployment ships with it.`);
