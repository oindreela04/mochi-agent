// Load .env if present (Node built-in; no dotenv dependency). Done here rather
// than with --env-file because that flag crashes `node --watch` when .env is missing.
try {
  process.loadEnvFile();
} catch {
  // no .env: fall back to the real environment
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  tavilyKey: process.env.TAVILY_API_KEY ?? '',
  /** Answers. Strong model: correctness and tone matter most here. */
  model: process.env.MODEL || 'claude-sonnet-5-5',
  /** Background fact extraction. Off the critical path, so a small fast model. */
  fastModel: process.env.FAST_MODEL || 'claude-haiku-5-5',
  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || 'data/agent.db',
  /** Example history for the memory questions. Committed to the repo; built on boot if missing. */
  demoPath: process.env.DEMO_PATH || 'demo/history.json',
  /** Lets the UI/API pretend it is another date, to test "last Tuesday" flows. */
  allowClockOverride: process.env.ALLOW_CLOCK_OVERRIDE !== 'false',
  /** Abuse limits for a public deployment. In-memory; reset on restart. */
  messagesPerHourPerVisitor: num(process.env.MESSAGES_PER_HOUR_PER_VISITOR, 40),
  messagesPerHourPerIp: num(process.env.MESSAGES_PER_HOUR_PER_IP, 80),
  messagesPerDay: num(process.env.MESSAGES_PER_DAY, 600),
  maxSearchRounds: 4,
  historyTurns: 12,
};

export function missingKeys(): string[] {
  return [
    !config.anthropicKey && 'ANTHROPIC_API_KEY',
    !config.tavilyKey && 'TAVILY_API_KEY',
  ].filter(Boolean) as string[];
}
