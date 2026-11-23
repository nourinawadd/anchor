// AI assistant orchestrator. The real LLM layer, coach and planner run; only
// the provider network is faked (global fetch), routed by system prompt.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import User from '../models/User.js';
import StudyTask from '../models/StudyTask.js';
import StudyPlan from '../models/StudyPlan.js';
import { resetLimiters } from '../llm/rateLimiter.js';
import { runAssistantTurn, validateResponse } from '../services/orchestrator/orchestrator.js';
import { routeByRules } from '../services/orchestrator/router.js';
import { userTodayStr, shiftDateStr } from '../utils/datetime.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const app = createApp();
const today = userTodayStr('UTC');
const day = (n) => shiftDateStr(today, n);

// ─── Fake provider, routed by which prompt the request carries ───────────────
let replies;
let delayMs;
const okResponse = (obj) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({
    choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  }),
});
const kindOf = (system) => (system.includes('You route a student') ? 'router'
  : system.includes('Anchor focus coach') ? 'coach'
  : system.includes("turn a student's description") ? 'parse'
  : 'other');
const callsOf = (kind) => fetchMock.mock.calls.filter(([, o]) => kindOf(JSON.parse(o.body).messages[0].content) === kind);

beforeEach(() => {
  fetchMock.mockReset();
  resetLimiters();
  for (const k of ['LLM_API_KEY', 'LLM_PROVIDER', 'LLM_FALLBACKS', 'GEMINI_API_KEY', 'AI_DAILY_LIMIT', 'LLM_MAX_RETRIES']) delete process.env[k];
  process.env.LLM_API_KEY = 'test-pat';     // fast tier → openai only
  process.env.LLM_MAX_RETRIES = '0';
  delayMs = 0;
  replies = {
    router: { focus: false, planner: false, study: false, offTopic: true },
    coach: { action: 'answer', toolCall: { name: 'none', arguments: '{}' }, sections: [{ kind: 'ai_suggestion', text: 'Try a short session in the afternoon.' }], dataGaps: [] },
    parse: { tasks: [], questions: [] },
  };
  fetchMock.mockImplementation(async (_url, opts) => {
    const kind = kindOf(JSON.parse(opts.body).messages[0].content);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    return okResponse(replies[kind] ?? {});
  });
});

let seq = 0;
async function makeUser() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Assistant User', email: `assistant-${seq++}@example.test`, password: 'sup3rsecret' });
  const token = reg.body.accessToken;
  const cats = await request(app).get('/api/user/categories').set('Authorization', `Bearer ${token}`);
  return { token, userId: reg.body.user.id, categories: cats.body };
}
const ask = (token, message) => request(app).post('/api/ai/assistant').set('Authorization', `Bearer ${token}`).send({ message });

// ─── Routing ─────────────────────────────────────────────────────────────────
describe('routing', () => {
  it('decides clear messages by keywords, without calling a model', () => {
    expect(routeByRules('Why was my focus low this week?')).toEqual({ agents: ['focus'], decided: true });
    expect(routeByRules('Physics exam Thursday, chapter 4 is hard')).toEqual({ agents: ['planner'], decided: true });
    expect(routeByRules('Explain integration by parts')).toEqual({ agents: ['study'], decided: true });
    expect(routeByRules('Why was I distracted, and plan my exam week').decided).toBe(false);
    expect(routeByRules('hello there').decided).toBe(false);
  });

  it('a focus question goes only to the coach (no router call)', async () => {
    const u = await makeUser();
    const r = await ask(u.token, 'Why was my focus low this week?');
    expect(r.status).toBe(200);
    expect(r.body.route).toEqual({ agents: ['focus'], source: 'rules' });
    expect(r.body.parts).toEqual([{ agent: 'focus', status: 'ok', sections: [{ kind: 'ai_suggestion', text: 'Try a short session in the afternoon.' }], dataGaps: [] }]);
    expect(callsOf('router')).toHaveLength(0);
    expect(callsOf('parse')).toHaveLength(0);
  });

  it('an ambiguous message asks the router model and runs both agents', async () => {
    const u = await makeUser();
    replies.router = { focus: true, planner: true, study: false, offTopic: false };
    replies.parse = { tasks: [{ title: 'Physics exam', courseName: '', kind: 'EXAM', deadline: day(4), deadlineTime: '', difficulty: 3, estimatedMinutes: 0 }], questions: [] };
    const r = await ask(u.token, 'Why was I distracted, and plan my exam week');
    expect(r.body.route).toEqual({ agents: ['focus', 'planner'], source: 'llm' });
    expect(r.body.parts.map(p => p.agent)).toEqual(['focus', 'planner']);
    expect(callsOf('router')).toHaveLength(1);
    expect(callsOf('coach')).toHaveLength(1);
    expect(callsOf('parse')).toHaveLength(1);
  });

  it('falls back to the keyword areas when the router model fails', async () => {
    const u = await makeUser();
    replies.router = 'not json';
    const r = await ask(u.token, 'Why was I distracted, and plan my exam week');
    expect(r.body.route.source).toBe('fallback');
    expect(r.body.route.agents).toEqual(['focus', 'planner']);
  });

  it('answers off-topic messages with a notice and no agent calls', async () => {
    const u = await makeUser();
    const r = await ask(u.token, 'hello there');
    expect(r.body.route.agents).toEqual([]);
    expect(r.body.parts).toEqual([]);
    expect(r.body.notice).toMatch(/focus sessions/);
    expect(callsOf('coach')).toHaveLength(0);
  });

  it('says course-material help is not available yet', async () => {
    const u = await makeUser();
    const r = await ask(u.token, 'Explain integration by parts');
    expect(r.body.parts).toEqual([expect.objectContaining({ agent: 'study', status: 'unavailable', reason: 'not_available_yet' })]);
  });
});

// ─── Planner agent: proposes, never writes ───────────────────────────────────
describe('planner agent', () => {
  it('returns new deadlines as a REVIEW_TASKS action and saves nothing', async () => {
    const u = await makeUser();
    replies.parse = { tasks: [{ title: 'Physics quiz', courseName: 'Learning', kind: 'QUIZ', deadline: day(3), deadlineTime: '10:00', difficulty: 2, estimatedMinutes: 0 }], questions: ['Which chapters?'] };
    const r = await ask(u.token, 'Physics quiz in 3 days');
    const part = r.body.parts[0];
    expect(part).toMatchObject({ agent: 'planner', status: 'ok', kind: 'review_tasks', questions: ['Which chapters?'] });
    expect(part.tasks[0]).toMatchObject({ title: 'Physics quiz', kind: 'QUIZ', deadline: day(3) });
    expect(r.body.actions).toEqual([{ type: 'REVIEW_TASKS', tasks: part.tasks }]);
    expect(await StudyTask.countDocuments()).toBe(0);
    expect(await StudyPlan.countDocuments()).toBe(0);
  });

  it('summarizes the plan for "what is my next session?" without an AI parse', async () => {
    const u = await makeUser();
    replies.router = { focus: false, planner: true, study: false, offTopic: false };
    const r = await ask(u.token, "What's my next session?");
    expect(r.body.parts[0]).toMatchObject({ agent: 'planner', kind: 'plan_status' });
    expect(r.body.parts[0].text).toMatch(/don't have a study plan/);
    expect(r.body.actions).toContainEqual({ type: 'START_PLAN' });
    expect(callsOf('parse')).toHaveLength(0);
  });
});

// ─── Intervention agent ──────────────────────────────────────────────────────
describe('intervention nudges', () => {
  it('nudges about missed plan blocks and a close deadline, with numbers from data', async () => {
    const u = await makeUser();
    const cat = u.categories[0].id;
    const task = await StudyTask.create({ userId: u.userId, categoryId: cat, title: 'Math assignment', kind: 'ASSIGNMENT', deadline: day(1), estimatedMinutes: 120, completedMinutes: 30 });
    await StudyPlan.create({
      userId: u.userId, status: 'ACTIVE', timezone: 'UTC', approvedAt: new Date(Date.parse(`${day(-2)}T00:00:00Z`)),
      blocks: [{ taskId: task._id, categoryId: cat, dateStr: day(-1), startMinute: 600, durationMinutes: 45, status: 'MISSED' }],
    });
    const r = await ask(u.token, 'Why was my focus low this week?');
    const codes = r.body.nudges.map(n => n.code);
    expect(codes).toEqual(['MISSED_BLOCKS', 'DEADLINE_SOON']);
    expect(r.body.nudges[0].text).toMatch(/missed 1 planned session/);
    expect(r.body.nudges[1].text).toBe('Math assignment is due tomorrow and still needs about 90 minutes.');
    expect(r.body.actions).toEqual(expect.arrayContaining([{ type: 'REPLAN' }, { type: 'OPEN_PLAN' }]));
  });
});

// ─── Robustness ──────────────────────────────────────────────────────────────
describe('robustness and validation', () => {
  it('a slow agent times out without blocking the others', async () => {
    const u = await makeUser();
    const user = await User.findById(u.userId);
    delayMs = 300;
    const r = await runAssistantTurn({ user, message: 'Why was my focus low?', only: ['focus', 'study'], timeoutMs: 50 });
    expect(r.parts).toEqual([
      { agent: 'focus', status: 'unavailable', reason: 'timeout' },
      expect.objectContaining({ agent: 'study', status: 'unavailable', reason: 'not_available_yet' }),
    ]);
  });

  it('the validator drops unknown agents, fields and action types', () => {
    const out = validateResponse({
      route: { agents: ['focus'], source: 'rules', secret: 'x' },
      parts: [
        { agent: 'focus', status: 'ok', sections: [], dataGaps: [], prompt: 'SYSTEM PROMPT', actions: [{ type: 'DELETE_ACCOUNT' }, { type: 'OPEN_PLAN' }] },
        { agent: 'hacker', status: 'ok' },
      ],
      nudges: [{ code: 'X', text: 'y', action: { type: 'REPLAN' }, raw: 1 }],
    });
    expect(out).toEqual({
      route: { agents: ['focus'], source: 'rules' },
      parts: [{ agent: 'focus', status: 'ok', sections: [], dataGaps: [] }],
      nudges: [{ code: 'X', text: 'y' }],
      actions: [{ type: 'OPEN_PLAN' }, { type: 'REPLAN' }],
    });
  });

  it('validates the request', async () => {
    const u = await makeUser();
    expect((await request(app).post('/api/ai/assistant').send({ message: 'hi' })).status).toBe(401);
    expect((await ask(u.token, '')).status).toBe(400);
    expect((await ask(u.token, 'x'.repeat(1001))).status).toBe(400);
    expect((await request(app).post('/api/ai/assistant').set('Authorization', `Bearer ${u.token}`).send({ message: 'hi', userId: 'other' })).status).toBe(400);
  });
});
