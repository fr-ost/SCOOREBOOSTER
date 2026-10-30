// ScoreX - conversation alerts: while running, reads your X mentions every few minutes and flags replies from the
// accounts you comment on (an author reply is the best moment for a follow-back - answer it yourself).
// The engine calls conversationsStep from its idle step (under the job lease, in the worker tab); the dashboard
// lists sx.conversations and marks items done with the conversationDone message. Nothing is ever posted from here.

import { K } from "./constants.js";
import { load, update } from "./store.js";

const EMPTY = { items: [], checkedAt: null };

export async function getConversations() { return load(K.conversations, EMPTY); }

// Returns { did: "mentions" } after reading the mentions page, { stop } on a safety stop, or null when nothing was due.
// eslint-disable-next-line no-unused-vars
export async function conversationsStep({ tabId, settings, me, shouldStop }) {
  return null;
}

export async function markDone(id, done = true) {
  let found = false;
  await update(K.conversations, EMPTY, (cur) => ({
    ...cur,
    items: (cur.items || []).map((x) => {
      if (!x || x.id !== id) return x;
      found = true;
      return { ...x, done: !!done };
    }),
  }));
  return found ? { ok: true } : { ok: false, error: "Not found" };
}
