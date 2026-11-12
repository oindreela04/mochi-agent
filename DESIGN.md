# Design

## The problem, restated

The three sample questions are mostly about time and memory, not search: "On Monday we shortlisted…", "What did I ask you on 3 November?", "Last Tuesday… has pricing changed since?". To answer them the agent has to know which day "last Tuesday" was, find what it said then, know the exact figures it gave, and re-check them. It also has to know who it is talking to: "a 20-person sales team" should still matter next week. Search is the easy part. So I designed the memory first and fitted search around it.

## How it works

```
message ─► recall (plain code, ~1 ms) ─► model ⇄ web_search (≤4 queries in parallel) ─► streamed answer
             dates → that day's chats + facts                                          │
             keywords → related chats                                save turn ─► extract memory (small model, background)
             profile → what we know about the user                                   claims + profile facts
```

**Time is resolved in code.** `memory/temporal.ts` maps "on Monday", "last week", "3 November", "the 3rd" to exact ranges in the user's timezone (DST-safe, unit tested). "Last Tuesday" said on a Wednesday could mean yesterday or eight days ago, so both are fetched and labelled, and the model says which date it used. Future dates are ignored.

**Recall costs no model call.** `memory/recall.ts` pulls every turn on the referenced dates, adds full-text (SQLite FTS5) matches when the message refers back ("we", "since", "you said"), and appends an index of recent questions. If a date has no chat, the prompt says so explicitly. That one line is what stops the model inventing a past conversation.

**Two kinds of memory, written after the reply.** One background call to a small model extracts:
- *claims*: checkable facts the answer stated (`Neon | Launch price | $19/mo | source`). For "has anything changed?", these are the baseline, and each is re-checked and reported as changed (old → new, cited), no change found, or couldn't verify.
- *profile*: durable facts the user revealed (team size, stack, currency, budget, answer style). They go into every later prompt, so answers are tailored without asking twice: per-seat prices become a total for your 20 reps. Newer facts replace older ones, sensitive categories are excluded, and the user sees the profile in the sidebar and can delete any item. Memory you can't inspect is a liability.

**One tool, used efficiently.** `web_search` takes up to 4 queries run in parallel, plus `recency` (for "since Monday"), `domains` (vendor pricing pages and changelogs) and `full_pages` (pricing tables rarely survive into snippets). Results carry publish dates. One registry numbers sources across the whole answer, so `[3]` stays stable, and a 10-minute cache makes follow-ups instant. The final round disables tools, so every request ends in an answer.

**Fast and pleasant.** Tokens stream over SSE. The UI shows the steps (recalled chats, profile used, each search), so the model doesn't narrate them. The static prompt is cached. Replies lead with the answer, cite every figure, and use tables only for comparisons.

**Deployable as a shared demo.** Each browser gets an anonymous id, and every query is scoped to it. A one-click set of example chats, answered by this agent with live search and dated to the visitor's last Monday, last Tuesday and 3 November, makes the memory questions testable on a first visit. Per-visitor, per-IP and daily rate limits protect the API budget. The store is a single SQLite file via Node's built-in `node:sqlite`, so there are no native modules or build step.

## Considered and rejected

- **Memory as a second tool** (`recall_history`): it adds a model round trip to exactly the questions that need memory, and resolving "last Tuesday" is parsing, not reasoning.
- **Embeddings or a vector DB**: one user's history is small. Dates, FTS and an index cover it with no extra service.
- **The provider's built-in web search**: I need raw results stored per turn (URLs, publish dates) to diff later, batched queries, and a swappable provider.
- **A router model deciding whether to search**: another hop before the first token, and the answering model makes this call well.
- **Summarising old chats**: "has the price changed?" needs the exact figure, which summaries lose.
- **An agent framework**: the loop is about 60 lines, and a framework would hide the parts worth reviewing.

## With another week

1. An eval suite in CI: scripted multi-day conversations (extending `npm run scenarios`) graded for correctness, valid citations, honesty when there's no record, and latency.
2. Scheduled re-checks of stored claims, so "what changed?" is an instant diff, and the agent can tell you before you ask.
3. Snapshots of pricing pages, so a change is proven by diff rather than inferred from two searches.
4. Normalised claims (currency, per-seat vs flat, annual vs monthly) for exact comparisons.
5. Real accounts, so memory follows a person across devices rather than a browser.
