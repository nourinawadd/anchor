// AI Focus Coach: conversation endpoints + the tool-calling turn loop.
// The real LLM layer runs; only the provider network is faked (global fetch),
// so no credentials are needed and nothing is billed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import Session from '../models/Session.js';
import CoachConversation from '../models/CoachConversation.js';
import { resetLimiters } from '../llm/rateLimiter.js';
import { MAX_TOOL_CALLS } from '../services/coach/coachService.js';
import { userTodayStr, shiftDateStr, localDayStartUtc } from '../utils/datetime.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const app = createApp();
const today = userTodayStr('UTC');
const yesterday = shiftDateStr(today, -1);
const WEEK = { from: shiftDateStr(today, -6), to: today };

// ─── Helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
async function makeUser() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Coach User', email: `coach-${seq++}@example.test`, password: 'sup3rsecret' });
  return { token: reg.body.accessToken, userId: reg.body.user.id, email: reg.body.user.email };
}
const authed = (method, url, token) => request(app)[method](url).set('Authorization', `Bearer ${token}`);

async function seedSession(userId, { minutes = 30, score = 80, hour = 9 } = {}) {
  const startedAt = new Date(localDayStartUtc(yesterday, 'UTC').getTime() + hour * 3600_000);
  return Session.create({
    userId, categoryId: 'work', status: 'COMPLETED', timerMode: 'COUNTDOWN',
    plannedDurationSec: minutes * 60, actualDurationSec: minutes * 60, focusScore: score,
    dateStr: yesterday, timezone: 'UTC', startedAt, endedAt: new Date(startedAt.getTime() + minutes * 60_000),
  });
}

// Model steps (what the fake provider "replies").
const callTool = (name, args = {}) => ({
  action: 'call_tool', toolCall: { name, arguments: JSON.stringify(args) }, sections: [], dataGaps: [],
});
const answer = (sections, dataGaps = []) => ({
  action: 'answer', toolCall: { name: 'none', arguments: '{}' }, sections, dataGaps,
});
const measured = (text) => ({ kind: 'measured_data', text });
const suggestion = (text) => ({ kind: 'ai_suggestion', text });

const okResponse = (body) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => body,
});
const openaiOk = (obj) => okResponse({
  choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
});
const geminiOk = (obj) => okResponse({
  candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
});
const httpErr = (status) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ error: { message: 'down' } }) });
const isGemini = (url) => String(url).includes('generativelanguage');

/** Queue provider replies; the last reply in a queue repeats. */
function script({ openai = [], gemini = [] }) {
  const take = (q) => (q.length > 1 ? q.shift() : q[0]);
  fetchMock.mockImplementation(async (url) => {
    const next = take(isGemini(url) ? gemini : openai);
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return next;
  });
}
const openaiScript = (...steps) => script({ openai: steps.map(openaiOk) });

/** Messages the model received on fetch call `i`. */
const sentMessages = (i) => {
  const [url, opts] = fetchMock.mock.calls[i];
  const body = JSON.parse(opts.body);
  if (!isGemini(url)) return body.messages;
  return [
    ...(body.systemInstruction ? [{ role: 'system', content: body.systemInstruction.parts[0].text }] : []),
    ...body.contents.map(c => ({ role: c.role, content: c.parts[0].text })),
  ];
};
const allSentText = () => fetchMock.mock.calls.map(([, o]) => o.body).join('\n');
const toolResultsSent = (i) => sentMessages(i).filter(m => m.content.startsWith('TOOL_RESULT'));

beforeEach(() => {
  fetchMock.mockReset();
  resetLimiters();
  for (const k of ['LLM_API_KEY', 'LLM_PROVIDER', 'LLM_FALLBACKS', 'GEMINI_API_KEY', 'AI_DAILY_LIMIT', 'LLM_MAX_RETRIES']) {
    delete process.env[k];
  }
  process.env.LLM_BACKOFF_BASE_MS = '1';
  process.env.LLM_API_KEY = 'test-pat';          // fast tier → openai only
});

async function startConversation(token) {
  const res = await authed('post', '/api/ai/coach/conversations', token).send({});
  expect(res.status).toBe(201);
  return res.body.conversation.id;
}
const send = (token, id, message) => authed('post', `/api/ai/coach/conversations/${id}/messages`, token).send({ message });

// ─── Authentication ──────────────────────────────────────────────────────────
describe('coach endpoints require authentication', () => {
  const id = '64b000000000000000000000';
  const routes = [
    ['get', '/api/ai/coach/conversations'],
    ['post', '/api/ai/coach/conversations'],
    ['get', `/api/ai/coach/conversations/${id}`],
    ['post', `/api/ai/coach/conversations/${id}/messages`],
    ['put', `/api/ai/coach/conversations/${id}/messages/${id}/feedback`],
    ['delete', `/api/ai/coach/conversations/${id}`],
  ];
  for (const [method, url] of routes) {
    it(`${method.toUpperCase()} ${url} → 401 without a token`, async () => {
      const res = await request(app)[method](url).send({ message: 'hi' });
      expect(res.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

// ─── Tool-calling flow ───────────────────────────────────────────────────────
describe('coach turn: tool calling', () => {
  it('runs user → tool selection → server tool → result → validated, labeled answer', async () => {
    const { token, userId, email } = await makeUser();
    await seedSession(userId, { minutes: 45, score: 82 });
    const id = await startConversation(token);

    openaiScript(
      callTool('getDailyAggregates', WEEK),
      answer([
        suggestion('Protect your morning block.'),
        measured('You focused 45 minutes yesterday with an average score of 82.'),
      ]),
    );
    const res = await send(token, id, 'How did I do this week?');
    expect(res.status).toBe(201);
    expect(res.body.reply).toMatchObject({
      role: 'assistant', status: 'ok', feedback: null,
      // measured figures are ordered before suggestions
      sections: [
        { kind: 'measured_data', text: 'You focused 45 minutes yesterday with an average score of 82.' },
        { kind: 'ai_suggestion', text: 'Protect your morning block.' },
      ],
    });

    // The server executed the tool and sent the result back to the model.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tr] = toolResultsSent(1);
    expect(tr.content).toContain('"focusMinutes":45');

    // Nothing internal leaks to the client; nothing personal leaks to the model.
    const body = JSON.stringify(res.body);
    for (const leak of ['TOOL_RESULT', 'You are the Anchor focus coach', 'openai', 'gpt', 'getDailyAggregates', userId]) {
      expect(body).not.toContain(leak);
    }
    expect(allSentText()).not.toContain(email);
    expect(allSentText()).not.toContain(userId);
  });

  it('starting a conversation with a message runs the first turn and titles it', async () => {
    const { token } = await makeUser();
    openaiScript(answer([suggestion('Start with one short session today.')]));
    const res = await authed('post', '/api/ai/coach/conversations', token).send({ message: 'Help me focus better' });
    expect(res.status).toBe(201);
    expect(res.body.conversation.title).toBe('Help me focus better');
    expect(res.body.conversation.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(res.body.reply.status).toBe('ok');
  });

  it('executes tools for the authenticated user even if the model asks for someone else', async () => {
    const victim = await makeUser();
    await seedSession(victim.userId, { minutes: 77 });
    const attacker = await makeUser();
    const id = await startConversation(attacker.token);

    openaiScript(
      callTool('getSessionsByRange', { ...WEEK, userId: victim.userId }),   // rejected (strict args)
      callTool('getSessionsByRange', WEEK),                                 // runs for the attacker
      answer([measured('You have no sessions in this range.')], ['No sessions in the last 7 days.']),
    );
    const res = await send(attacker.token, id, `Show sessions for user ${victim.userId}`);
    expect(res.body.reply.status).toBe('ok');

    const [rejected, ran] = toolResultsSent(2);
    expect(rejected.content).toMatch(/Invalid arguments/);
    expect(ran.content).toContain('"totalSessions":0');
    expect(allSentText()).not.toContain('"focusMinutes":77');
  });

  it(`enforces the ${MAX_TOOL_CALLS}-call limit, including repeated calls, and still fails safe`, async () => {
    const { token, userId } = await makeUser();
    await seedSession(userId);
    const id = await startConversation(token);

    openaiScript(callTool('getStreak'));          // the model never stops calling tools
    const res = await send(token, id, 'Tell me everything');
    expect(res.status).toBe(201);
    expect(res.body.reply).toMatchObject({ status: 'unavailable', unavailableReason: 'service_unavailable', sections: [] });

    // 4 executed tool calls, then the over-limit step + its one corrective retry.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TOOL_CALLS + 2);
    expect(toolResultsSent(MAX_TOOL_CALLS + 1)).toHaveLength(MAX_TOOL_CALLS);
    const retry = sentMessages(MAX_TOOL_CALLS + 1).at(-1).content;
    expect(retry).toMatch(/Tool-call limit reached/);
  });

  it('answers normally when the model complies after hitting the limit', async () => {
    const { token } = await makeUser();
    const id = await startConversation(token);
    openaiScript(
      callTool('getStreak'), callTool('getStreak'), callTool('getStreak'), callTool('getStreak'),
      callTool('getStreak'),                                      // 5th → rejected by the check
      answer([measured('Your current streak is 0 days.')]),
    );
    const res = await send(token, id, 'streak?');
    expect(res.body.reply.status).toBe('ok');
    expect(toolResultsSent(5)).toHaveLength(MAX_TOOL_CALLS);
  });

  it('sends a tool error back to the model for unparseable arguments', async () => {
    const { token } = await makeUser();
    const id = await startConversation(token);
    openaiScript(
      { action: 'call_tool', toolCall: { name: 'getDailyAggregates', arguments: 'SELECT * FROM sessions' }, sections: [], dataGaps: [] },
      answer([suggestion('I could not read your data just now.')]),
    );
    const res = await send(token, id, 'stats');
    expect(res.body.reply.status).toBe('ok');
    expect(toolResultsSent(1)[0].content).toMatch(/must be a JSON-encoded object/);
  });
});

// ─── Answer validation ───────────────────────────────────────────────────────
describe('coach turn: answer validation', () => {
  it('rejects unsupported numeric claims, retries once with feedback, and returns only the grounded answer', async () => {
    const { token, userId } = await makeUser();
    await seedSession(userId, { minutes: 45 });
    const id = await startConversation(token);

    openaiScript(
      callTool('getDailyAggregates', WEEK),
      answer([measured('You focused 999 minutes, up 37% on last week.')]),   // invented
      answer([measured('You focused 45 minutes this week.')]),               // grounded
    );
    const res = await send(token, id, 'How much did I focus?');
    expect(res.body.reply.status).toBe('ok');
    expect(res.body.reply.sections).toEqual([measured('You focused 45 minutes this week.')]);
    expect(JSON.stringify(res.body)).not.toMatch(/999|37%/);
    expect(sentMessages(2).at(-1).content).toMatch(/not in this turn's tool results: 999, 37/);
  });

  it('never returns unvalidated text when the model keeps inventing numbers', async () => {
    const { token } = await makeUser();
    const id = await startConversation(token);
    openaiScript(answer([measured('You averaged 52 minutes per session.')]));   // no tool call at all

    const res = await send(token, id, 'average?');
    expect(res.body.reply).toMatchObject({ status: 'unavailable', sections: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);                  // bounded: original + one retry
    const stored = await CoachConversation.findById(id).lean();
    // Check only what was stored as message text: the whole document also
    // holds random ObjectIds, which contain "52" by chance (flaky in CI).
    const storedText = stored.messages.map(m => ({ content: m.content, sections: m.sections, dataGaps: m.dataGaps, notice: m.notice }));
    expect(JSON.stringify(storedText)).not.toContain('52');
  });

  it('handles missing data without inventing values', async () => {
    const { token } = await makeUser();                          // no sessions at all
    const id = await startConversation(token);
    openaiScript(
      callTool('getHourlyAverages', WEEK),
      answer([measured('Your best hour is 09:00 with 40 minutes on average.')]),  // invented
      answer([suggestion('Try a few sessions at different times so patterns can show up.')],
             ['No completed sessions in the last 7 days, so there is no best hour yet.']),
    );
    const res = await send(token, id, 'When do I focus best?');
    expect(res.body.reply).toMatchObject({
      status: 'ok',
      dataGaps: ['No completed sessions in the last 7 days, so there is no best hour yet.'],
    });
    expect(JSON.stringify(res.body.reply)).not.toMatch(/09:00|40 minutes/);
  });

  it('a number the user typed may appear in a suggestion but never as measured data', async () => {
    const { token } = await makeUser();
    const id = await startConversation(token);
    openaiScript(
      answer([measured('You focused 500 minutes this week.')]),
      answer([suggestion('If you did 500 minutes, keep sessions short to avoid burnout.')],
             ['I have no measured data yet to confirm that.']),
    );
    const res = await send(token, id, 'I did 500 minutes this week, is that good?');
    expect(res.body.reply.status).toBe('ok');
    expect(res.body.reply.sections[0].kind).toBe('ai_suggestion');
    expect(sentMessages(1).at(-1).content).toMatch(/measured_data sections contain numbers .*500/);
  });

  it('accepts rounded and minutes→hours derivations of tool figures', async () => {
    const { token, userId } = await makeUser();
    await seedSession(userId, { minutes: 90 });
    const id = await startConversation(token);
    openaiScript(callTool('getDailyAggregates', WEEK), answer([measured('That is 1.5 hours (90 minutes) of focus.')]));
    expect((await send(token, id, 'hours?')).body.reply.status).toBe('ok');
  });

  it('numbers from earlier validated answers count as conversation context', async () => {
    const { token, userId } = await makeUser();
    await seedSession(userId, { minutes: 45 });
    const id = await startConversation(token);
    openaiScript(callTool('getDailyAggregates', WEEK), answer([measured('You focused 45 minutes this week.')]));
    await send(token, id, 'How much?');

    fetchMock.mockReset();
    openaiScript(answer([measured('As noted, that was 45 minutes.')]));
    const res = await send(token, id, 'Remind me?');
    expect(res.body.reply.status).toBe('ok');
    // Prior turn reached the model as context; its tool traffic did not.
    const msgs = sentMessages(0);
    expect(msgs.some(m => m.role === 'assistant' && m.content.includes('45 minutes'))).toBe(true);
    expect(msgs.some(m => m.content.startsWith('TOOL_RESULT'))).toBe(false);
  });

  it('rejects schema-invalid output (bad JSON, unknown labels) with retry, then falls back to the next provider', async () => {
    process.env.GEMINI_API_KEY = 'gk';             // fast tier: gemini flash-lite → openai
    const { token } = await makeUser();
    const id = await startConversation(token);
    script({
      gemini: [geminiOk('not json at all'), geminiOk(answer([{ kind: 'opinion', text: 'x' }]))],
      openai: [openaiOk(answer([suggestion('Try one 25-minute session.')])), openaiOk(answer([suggestion('Start with one short session.')]))],
    });
    const res = await send(token, id, 'tip?');
    expect(res.body.reply).toMatchObject({ status: 'ok', sections: [suggestion('Start with one short session.')] });

    const urls = fetchMock.mock.calls.map(([u]) => (isGemini(u) ? 'gemini' : 'openai'));
    expect(urls).toEqual(['gemini', 'gemini', 'openai', 'openai']);   // ungrounded "25" also retried
  });

  it('fails safe when every provider errors', async () => {
    process.env.GEMINI_API_KEY = 'gk';
    process.env.LLM_MAX_RETRIES = '0';
    const { token } = await makeUser();
    const id = await startConversation(token);
    script({ gemini: [httpErr(503)], openai: [httpErr(500)] });

    const res = await send(token, id, 'hello');
    expect(res.status).toBe(201);
    expect(res.body.reply).toMatchObject({ status: 'unavailable', unavailableReason: 'service_unavailable', sections: [], dataGaps: [] });
    expect(res.body.reply.notice).toMatch(/couldn't answer/);
    expect(JSON.stringify(res.body)).not.toMatch(/503|500|gemini|openai|down/);
  });

  it('reports the per-user daily AI limit without calling the provider again', async () => {
    process.env.AI_DAILY_LIMIT = '1';
    const { token } = await makeUser();
    const id = await startConversation(token);
    openaiScript(callTool('getStreak'));
    const res = await send(token, id, 'streak?');
    expect(res.body.reply).toMatchObject({ status: 'unavailable', unavailableReason: 'daily_limit' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Ownership ───────────────────────────────────────────────────────────────
describe('coach conversations: ownership', () => {
  async function ownedConversation() {
    const owner = await makeUser();
    openaiScript(answer([suggestion('Keep going.')]));
    const res = await authed('post', '/api/ai/coach/conversations', owner.token).send({ message: 'private question' });
    fetchMock.mockReset();
    return { owner, id: res.body.conversation.id, assistantId: res.body.reply.id };
  }

  it('another user cannot read, message, rate or delete the conversation', async () => {
    const { owner, id, assistantId } = await ownedConversation();
    const other = await makeUser();

    expect((await authed('get', `/api/ai/coach/conversations/${id}`, other.token)).status).toBe(404);
    expect((await send(other.token, id, 'hi')).status).toBe(404);
    expect((await authed('put', `/api/ai/coach/conversations/${id}/messages/${assistantId}/feedback`, other.token)
      .send({ rating: 'down' })).status).toBe(404);
    expect((await authed('delete', `/api/ai/coach/conversations/${id}`, other.token)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();

    const list = await authed('get', '/api/ai/coach/conversations', other.token);
    expect(list.body.conversations).toEqual([]);

    // Owner's conversation is untouched.
    const mine = await authed('get', `/api/ai/coach/conversations/${id}`, owner.token);
    expect(mine.status).toBe(200);
    expect(mine.body.conversation.messages).toHaveLength(2);
    expect(mine.body.conversation.messages[1].feedback).toBeNull();
  });

  it('history returns the owner\'s messages in order with no internal fields', async () => {
    const { owner, id } = await ownedConversation();
    const res = await authed('get', `/api/ai/coach/conversations/${id}`, owner.token);
    expect(res.status).toBe(200);
    const { conversation } = res.body;
    expect(conversation.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(conversation.messages[0].content).toBe('private question');
    expect(conversation.messages[1].sections).toEqual([suggestion('Keep going.')]);
    expect(conversation).not.toHaveProperty('userId');
    expect(JSON.stringify(conversation)).not.toMatch(/system|TOOL_RESULT|provider|model/i);

    const list = await authed('get', '/api/ai/coach/conversations', owner.token);
    expect(list.body.conversations).toEqual([expect.objectContaining({ id, messageCount: 2 })]);
    expect(list.body.conversations[0]).not.toHaveProperty('messages');
  });

  it('delete removes the owner\'s conversation and is not repeatable', async () => {
    const { owner, id } = await ownedConversation();
    expect((await authed('delete', `/api/ai/coach/conversations/${id}`, owner.token)).body).toEqual({ deleted: true });
    expect((await authed('get', `/api/ai/coach/conversations/${id}`, owner.token)).status).toBe(404);
    expect((await authed('delete', `/api/ai/coach/conversations/${id}`, owner.token)).status).toBe(404);
    expect(await CoachConversation.countDocuments({})).toBe(0);
  });

  it('feedback: owner can rate assistant messages up/down/null', async () => {
    const { owner, id, assistantId } = await ownedConversation();
    const url = `/api/ai/coach/conversations/${id}/messages/${assistantId}/feedback`;
    expect((await authed('put', url, owner.token).send({ rating: 'up' })).body).toEqual({ id: assistantId, feedback: 'up' });
    expect((await authed('put', url, owner.token).send({ rating: null })).body.feedback).toBeNull();
    await authed('put', url, owner.token).send({ rating: 'down' });
    const res = await authed('get', `/api/ai/coach/conversations/${id}`, owner.token);
    expect(res.body.conversation.messages[1].feedback).toBe('down');
  });

  it('feedback cannot target a user message', async () => {
    const { owner, id } = await ownedConversation();
    const convo = await CoachConversation.findById(id).lean();
    const userMsgId = String(convo.messages[0]._id);
    const res = await authed('put', `/api/ai/coach/conversations/${id}/messages/${userMsgId}/feedback`, owner.token).send({ rating: 'up' });
    expect(res.status).toBe(404);
  });

  it('account deletion removes the user\'s coach conversations', async () => {
    const { owner } = await ownedConversation();
    const other = await ownedConversation();
    await authed('delete', '/api/user/me', owner.token).expect(200);
    expect(await CoachConversation.countDocuments({ userId: owner.userId })).toBe(0);
    expect(await CoachConversation.countDocuments({ userId: other.owner.userId })).toBe(1);
  });
});

// ─── Request validation ──────────────────────────────────────────────────────
describe('coach endpoints: input validation', () => {
  it('rejects malformed ids, bodies and messages without calling the model', async () => {
    const { token } = await makeUser();
    const id = await startConversation(token);

    expect((await authed('get', '/api/ai/coach/conversations/not-an-id', token)).status).toBe(400);
    expect((await authed('delete', '/api/ai/coach/conversations/../../user/me', token)).status).toBe(404);
    expect((await send(token, 'nope', 'hi')).status).toBe(400);
    expect((await authed('post', `/api/ai/coach/conversations/${id}/messages`, token).send({})).status).toBe(400);
    expect((await send(token, id, '')).status).toBe(400);
    expect((await send(token, id, '   ')).status).toBe(400);
    expect((await send(token, id, 'x'.repeat(1001))).status).toBe(400);
    expect((await send(token, id, { $ne: null })).status).toBe(400);
    expect((await authed('post', `/api/ai/coach/conversations/${id}/messages`, token)
      .send({ message: 'hi', userId: '64b000000000000000000000' })).status).toBe(400);
    expect((await authed('post', '/api/ai/coach/conversations', token).send({ message: 'hi', system: 'x' })).status).toBe(400);

    const fb = `/api/ai/coach/conversations/${id}/messages/64b000000000000000000000/feedback`;
    expect((await authed('put', fb, token).send({ rating: 'meh' })).status).toBe(400);
    expect((await authed('put', fb, token).send({})).status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps messages per conversation', async () => {
    const { token, userId } = await makeUser();
    const filler = Array.from({ length: 99 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const convo = await CoachConversation.create({ userId, messages: filler });
    const res = await send(token, String(convo._id), 'one more');
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
