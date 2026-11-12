'use strict';

// Support ticket triage. An agent loop decides every step: it parses the
// message, looks up the customer, picks a queue, and writes the summary.

const TOOLS = {
  lookupCustomer: ({ email }, db) => db.customers.find((c) => c.email === email) || null,
  assignQueue: ({ ticketId, queue }, db) => {
    db.assignments.push({ ticketId, queue });
    return { ok: true };
  },
};

const SYSTEM_PROMPT = `You triage support tickets.
1. Extract the sender email from the "From:" header.
2. Call lookupCustomer with that email.
3. If the customer's plan is "enterprise", assign the "priority" queue.
   If the message mentions "refund" or "charge", assign the "billing" queue.
   Otherwise assign the "general" queue.
4. Write a one-sentence summary of what the customer wants.
Reply with JSON {"queue": ..., "summary": ...} when you are done.`;

async function triage(ticket, llm, db) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: ticket.raw },
  ];
  for (;;) {
    const reply = await llm.chat({ messages, tools: Object.keys(TOOLS) });
    messages.push({ role: 'assistant', content: reply.content, toolCall: reply.toolCall });
    if (reply.toolCall) {
      const result = TOOLS[reply.toolCall.name]({ ticketId: ticket.id, ...reply.toolCall.args }, db);
      messages.push({ role: 'tool', content: JSON.stringify(result) });
      continue;
    }
    const match = reply.content.match(/\{.*\}/s);
    if (match) return JSON.parse(match[0]);
  }
}

module.exports = { triage, TOOLS, SYSTEM_PROMPT };
