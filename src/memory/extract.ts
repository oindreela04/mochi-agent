// After an answer is sent, one call to a small model writes two kinds of memory:
//
//  - claims:  checkable facts the answer stated ("HubSpot Sales Hub Pro: $100/seat/mo").
//             Days later, "has any of that changed?" re-verifies these item by item.
//  - profile: durable facts about the user ("sales team size: 20", "currency: INR").
//             Every later answer is tailored with them, in any chat.
//
// It runs in the background, so it adds no latency to the reply.

import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from '../config.js';
import type { ProfileFact, Store, Turn } from '../db.js';

const Memory = z.object({
  claims: z
    .array(
      z.object({
        subject: z.string().describe('The entity, e.g. "Neon" or "HubSpot Sales Hub"'),
        attribute: z.string().describe('What about it, e.g. "Launch plan price" or "on shortlist"'),
        value: z.string().describe('The value as stated, with units and period, e.g. "$19/month"'),
        source: z.number().int().nullable().describe('Citation number [n] backing it, or null'),
      }),
    )
    .max(30),
  profile: z
    .array(
      z.object({
        key: z.string().describe('Short stable label, e.g. "sales team size", "database", "currency", "answer style"'),
        value: z.string().describe('The fact, e.g. "20 people". Empty string if the user retracted it.'),
      }),
    )
    .max(10),
});

const INSTRUCTIONS = `You maintain an assistant's memory. From one exchange, extract two lists.

claims: concrete, checkable facts the ANSWER stated that could change over time: prices and plan names, limits, feature availability, release dates, versions, who holds a role, rankings, and any list the user and assistant settled on (for a shortlist, one claim per item with attribute "on shortlist"). Skip opinions, advice and timeless facts. Keep values exactly as stated, with units.

profile: durable facts the USER revealed about themselves or their work that would help tailor future answers: company or team size, role, industry, location or currency, tech stack, tools they use, budget, constraints, goals, and stated preferences about answers (e.g. "prefers short answers", "wants prices in INR"). Only what the user said or clearly implied, never guesses, and never what the assistant said. Skip one-off details of this request. Skip anything sensitive (health, religion, politics, sexuality, finances beyond a business budget, contact details). Reuse a key from the existing profile when updating it; give an empty value if the user retracted a fact.

Either list may be empty.`;

export async function extractMemory(llm: Pick<Anthropic, 'messages'>, store: Store, turn: Turn): Promise<void> {
  const known = store.getProfile(turn.userId);
  const msg = await llm.messages.parse({
    model: config.fastModel,
    max_tokens: 2000,
    system: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: [
          `Existing profile:\n${formatProfile(known) || '(empty)'}`,
          `User:\n${turn.userText}`,
          `Assistant:\n${turn.assistantText}`,
          turn.sources.length ? `Sources:\n${turn.sources.map((s) => `[${s.n}] ${s.url}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    output_config: { format: zodOutputFormat(Memory) },
  });
  const parsed = msg.parsed_output;
  if (!parsed) return;

  const urlFor = new Map(turn.sources.map((s) => [s.n, s.url]));
  store.addClaims(
    parsed.claims.map((c) => ({
      turnId: turn.id,
      subject: c.subject,
      attribute: c.attribute,
      value: c.value,
      sourceUrl: c.source != null ? (urlFor.get(c.source) ?? null) : null,
    })),
  );
  store.upsertProfile(turn.userId, parsed.profile, turn.id, turn.createdAt);
}

export function formatProfile(facts: ProfileFact[]): string {
  return facts.map((f) => `- ${f.key}: ${f.value}`).join('\n');
}
