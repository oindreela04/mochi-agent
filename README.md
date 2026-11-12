# Mochi

A search agent with memory, built for the minimi hiring challenge. It has one tool, web search. It remembers your earlier chats by date and learns what matters to you. Ask *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since?"* and it finds that chat, takes the prices it gave you as the baseline, re-checks each one, and tells you what changed, with sources.

[DESIGN.md](DESIGN.md) explains how it works and why.

## Run locally

Requires Node 22.13 or newer.

```bash
cp .env.example .env     # add ANTHROPIC_API_KEY and TAVILY_API_KEY
npm install
npm run dev              # http://localhost:3000
```

## Trying the memory questions

They need earlier chats. On a first visit, click **Load example history**. That adds three chats answered by this agent, dated your last Monday, last Tuesday and 3 November, and labelled "Example". Then ask the suggested questions.

You can also make your own history:
- Set **Pretend it's** in the sidebar to a past date, ask something, then clear it and follow up as today.
- POST to `/api/history` with `[{ "at": "<ISO time>", "user": "…", "assistant": "…" }]`.

`npm run scenarios` replays the challenge's examples across simulated days against the real APIs and prints each answer with timings.

## Deploy (Render)

`render.yaml` defines one web service with a 1 GB disk for the SQLite file. In Render: **New → Blueprint**, pick this repo, and paste the two API keys when asked. Free instances are not suitable, because they sleep after 15 idle minutes and lose their disk, which would wipe everyone's memory.

The example history ships in `demo/history.json`. If that file is missing, the server builds it with the real agent on first boot, which takes about a minute. Regenerate it with `npm run demo:build`.

Optional limits: `MESSAGES_PER_HOUR_PER_VISITOR` (40), `MESSAGES_PER_HOUR_PER_IP` (80), `MESSAGES_PER_DAY` (600).

## Tests

```bash
npm test          # dates, recall, profile, visitor isolation, rate limits, agent loop with a scripted model
npm run typecheck
```

## Layout

```
src/
  main.ts             boot: store, model client, search provider, example history
  server.ts           HTTP + SSE, visitor cookie, rate limits
  agent/run.ts        the loop: recall → model ⇄ web_search → stream → save → extract memory
  agent/prompt.ts     system prompt
  search.ts           web_search: parallel queries, source numbering, cache (Tavily)
  memory/temporal.ts  "last Tuesday" → exact ranges in the user's timezone
  memory/recall.ts    the memory section of the prompt
  memory/extract.ts   background extraction of claims and profile facts
  demo.ts             example history: build once, load per visitor with re-anchored dates
  db.ts               SQLite (node:sqlite) with full-text search, scoped per visitor
  ratelimit.ts        fixed-window limits
public/index.html     the chat UI
test/                 unit and end-to-end tests
```
