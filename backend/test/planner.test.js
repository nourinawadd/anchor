// Study Planner API. The real LLM layer runs; only the provider network is
// faked (global fetch), so no credentials are needed and nothing is billed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import StudyTask from '../models/StudyTask.js';
import StudyPlan from '../models/StudyPlan.js';
import Session from '../models/Session.js';
import { resetLimiters } from '../llm/rateLimiter.js';
import { userTodayStr, shiftDateStr } from '../utils/datetime.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const app = createApp();
const today = userTodayStr('UTC');
const day = (n) => shiftDateStr(today, n);

// ─── Fake provider ───────────────────────────────────────────────────────────
// Replies are chosen by which planner prompt the request carries.
let parseReplies = [];
let explainReplies = [];
const openaiOk = (obj) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({
    choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  }),
});
const take = (q, dflt) => (q.length > 1 ? q.shift() : (q[0] ?? dflt));
function installProvider() {
  fetchMock.mockImplementation(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const system = body.messages.find(m => m.role === 'system')?.content ?? '';
    if (system.includes('explain a study plan')) return openaiOk(take(explainReplies, { explanation: 'Your plan is ready. Blocks sit in your best focus hours.' }));
    return openaiOk(take(parseReplies, { tasks: [], questions: [] }));
  });
}
const sentSystemPrompts = () => fetchMock.mock.calls.map(([, o]) => JSON.parse(o.body).messages[0].content);

beforeEach(() => {
  fetchMock.mockReset();
  resetLimiters();
  for (const k of ['LLM_API_KEY', 'LLM_PROVIDER', 'LLM_FALLBACKS', 'GEMINI_API_KEY', 'AI_DAILY_LIMIT', 'LLM_MAX_RETRIES']) delete process.env[k];
  process.env.LLM_API_KEY = 'test-pat';     // fast tier → openai only
  process.env.LLM_MAX_RETRIES = '0';
  parseReplies = [];
  explainReplies = [];
  installProvider();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
async function makeUser() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Planner User', email: `planner-${seq++}@example.test`, password: 'sup3rsecret' });
  const token = reg.body.accessToken;
  const cats = await request(app).get('/api/user/categories').set('Authorization', `Bearer ${token}`);
  const learning = cats.body.find(c => c.name === 'Learning');
  return { token, userId: reg.body.user.id, categoryId: learning.id, categories: cats.body };
}
const authed = (method, url, token) => request(app)[method](url).set('Authorization', `Bearer ${token}`);

// Study windows all day, every day, so tests don't depend on the clock.
async function allDayWindows(token) {
  const windows = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: 0, end: 1440 }));
  const r = await authed('put', '/api/planner/settings', token).send({ windows, noStudyAfter: 1440, maxDailyMinutes: 480 });
  expect(r.status).toBe(200);
}

async function addTask(u, over = {}) {
  const r = await authed('post', '/api/planner/tasks', u.token).send({ tasks: [{
    title: 'Physics exam', categoryId: u.categoryId, kind: 'EXAM', deadline: day(5), difficulty: 3, estimatedMinutes: 150, ...over,
  }] });
  expect(r.status).toBe(201);
  return r.body.tasks[0];
}

async function approvedPlan(u) {
  const prev = await authed('post', '/api/planner/preview', u.token);
  expect(prev.status).toBe(201);
  const ok = await authed('post', `/api/planner/plans/${prev.body.plan.id}/approve`, u.token);
  expect(ok.status).toBe(200);
  return ok.body.plan;
}

// ─── Settings ────────────────────────────────────────────────────────────────
describe('planner settings', () => {
  it('returns defaults and validates updates', async () => {
    const u = await makeUser();
    const get = await authed('get', '/api/planner/settings', u.token);
    expect(get.body).toMatchObject({ maxDailyMinutes: 240, sessionLength: 50, breakBetween: 10, noStudyAfter: 1380 });
    expect(get.body.windows).toHaveLength(7);

    const ok = await authed('put', '/api/planner/settings', u.token).send({ sessionLength: 40 });
    expect(ok.body.sessionLength).toBe(40);

    expect((await authed('put', '/api/planner/settings', u.token).send({ windows: [{ weekday: 1, start: 600, end: 500 }] })).status).toBe(400);
    expect((await authed('put', '/api/planner/settings', u.token).send({ sessionLength: 5 })).status).toBe(400);
    expect((await authed('put', '/api/planner/settings', u.token).send({ hacker: true })).status).toBe(400);
  });
});

// ─── Tasks ───────────────────────────────────────────────────────────────────
describe('planner tasks', () => {
  it('creates, lists, edits and deletes tasks', async () => {
    const u = await makeUser();
    const t = await addTask(u);
    expect(t).toMatchObject({ title: 'Physics exam', kind: 'EXAM', remainingMinutes: 150, status: 'OPEN' });

    const list = await authed('get', '/api/planner/tasks', u.token);
    expect(list.body.tasks.map(x => x.id)).toEqual([t.id]);

    const patched = await authed('patch', `/api/planner/tasks/${t.id}`, u.token).send({ estimatedMinutes: 200, difficulty: 2 });
    expect(patched.body.task).toMatchObject({ estimatedMinutes: 200, difficulty: 2 });

    expect((await authed('delete', `/api/planner/tasks/${t.id}`, u.token)).body).toEqual({ deleted: true });
    expect((await authed('get', '/api/planner/tasks', u.token)).body.tasks).toEqual([]);
  });

  it('rejects unknown categories, past deadlines and bad fields', async () => {
    const u = await makeUser();
    const send = (task) => authed('post', '/api/planner/tasks', u.token).send({ tasks: [{
      title: 'X', categoryId: u.categoryId, deadline: day(3), estimatedMinutes: 60, ...task,
    }] });
    expect((await send({ categoryId: 'not-mine' })).status).toBe(400);
    expect((await send({ deadline: day(-1) })).status).toBe(400);
    expect((await send({ deadline: '2026-02-30' })).status).toBe(400);
    expect((await send({ estimatedMinutes: 5 })).status).toBe(400);
    expect((await send({ userId: 'someone-else' })).status).toBe(400);
  });

  it("hides another user's tasks (404)", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const t = await addTask(a);
    expect((await authed('patch', `/api/planner/tasks/${t.id}`, b.token).send({ title: 'mine' })).status).toBe(404);
    expect((await authed('delete', `/api/planner/tasks/${t.id}`, b.token)).status).toBe(404);
  });
});

// ─── Parse (AI) ──────────────────────────────────────────────────────────────
describe('POST /api/planner/parse', () => {
  it('turns text into draft tasks, mapped to the user\'s categories, without saving', async () => {
    const u = await makeUser();
    parseReplies = [{
      tasks: [
        { title: 'Physics quiz – chapter 4', courseName: 'learning', kind: 'QUIZ', deadline: day(3), deadlineTime: '10:00', difficulty: 3, estimatedMinutes: 0 },
        { title: 'Essay', courseName: '', kind: 'ASSIGNMENT', deadline: day(6), deadlineTime: '', difficulty: 2, estimatedMinutes: 240 },
      ],
      questions: ['Which chapters does the quiz cover?'],
    }];
    const r = await authed('post', '/api/planner/parse', u.token).send({ text: 'Physics quiz in 3 days, ch 4 is hard. Essay due in 6 days, about 4 hours.' });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('llm');
    expect(r.body.tasks[0]).toMatchObject({ categoryId: u.categoryId, kind: 'QUIZ', deadlineTime: '10:00', estimatedMinutes: 180, estimateSource: 'default' });
    expect(r.body.tasks[1]).toMatchObject({ categoryId: null, estimatedMinutes: 240, estimateSource: 'user', deadlineTime: null });
    expect(r.body.questions).toEqual(['Which chapters does the quiz cover?']);
    expect(await StudyTask.countDocuments()).toBe(0);
    expect(sentSystemPrompts()[0]).toContain(`Today is ${today}`);
  });

  it('feeds a past deadline back to the model once, then accepts the fix', async () => {
    const u = await makeUser();
    const t = (deadline) => ({ tasks: [{ title: 'Quiz', courseName: '', kind: 'QUIZ', deadline, deadlineTime: '', difficulty: 2, estimatedMinutes: 0 }], questions: [] });
    parseReplies = [t(day(-2)), t(day(5))];
    const r = await authed('post', '/api/planner/parse', u.token).send({ text: 'quiz on Monday' });
    expect(r.body.tasks[0].deadline).toBe(day(5));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to an empty result (use the form) when the model keeps failing', async () => {
    const u = await makeUser();
    parseReplies = ['not json at all'];
    const r = await authed('post', '/api/planner/parse', u.token).send({ text: 'exam friday' });
    expect(r.body).toMatchObject({ tasks: [], questions: [], source: 'fallback', unavailableReason: 'service_unavailable' });
  });
});

// ─── Preview / approve / plan ────────────────────────────────────────────────
describe('plans', () => {
  it('previews a DRAFT, approves it, and serves it as the active plan', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    const t = await addTask(u);

    const prev = await authed('post', '/api/planner/preview', u.token);
    expect(prev.status).toBe(201);
    const draft = prev.body.plan;
    expect(draft.status).toBe('DRAFT');
    expect(draft.explanationSource).toBe('llm');
    const study = draft.blocks.filter(b => b.kind === 'STUDY');
    expect(study.reduce((a, b) => a + b.durationMinutes, 0)).toBe(150);
    expect(draft.blocks.some(b => b.kind === 'REVIEW' && b.dateStr === day(4))).toBe(true);
    for (const b of draft.blocks) {
      expect(b.dateStr < t.deadline).toBe(true);
      expect(b.taskTitle).toBe('Physics exam');
    }
    expect((await authed('get', '/api/planner/plan', u.token)).body.plan).toBe(null);   // not active yet

    const ok = await authed('post', `/api/planner/plans/${draft.id}/approve`, u.token);
    expect(ok.body.plan.status).toBe('ACTIVE');
    const active = await authed('get', '/api/planner/plan', u.token);
    expect(active.body.plan.id).toBe(draft.id);
    expect(active.body.plan.replanSuggested).toBe(false);
    expect((await authed('get', '/api/planner/draft', u.token)).body.plan).toBe(null);
  });

  it('uses a rule-based explanation when the model invents numbers', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    explainReplies = [{ explanation: 'You will study 999 hours, which is a lot of work.' }];
    const prev = await authed('post', '/api/planner/preview', u.token);
    expect(prev.body.plan.explanationSource).toBe('fallback');
    expect(prev.body.plan.explanation).not.toContain('999');
    expect(prev.body.plan.explanation).toMatch(/study blocks/);
  });

  it('archives the previous plan on approve and keeps finished blocks when re-planning', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const first = await approvedPlan(u);
    const doneId = first.blocks[0].id;
    await StudyPlan.updateOne({ _id: first.id, 'blocks._id': doneId }, { $set: { 'blocks.$.status': 'DONE' } });

    const re = await authed('post', '/api/planner/replan', u.token);
    expect(re.body.plan.reason).toBe('REPLAN');
    expect(re.body.plan.blocks.find(b => b.id === doneId)?.status).toBe('DONE');
    await authed('post', `/api/planner/plans/${re.body.plan.id}/approve`, u.token);
    expect(await StudyPlan.countDocuments({ userId: u.userId, status: 'ARCHIVED' })).toBe(1);
    expect(await StudyPlan.countDocuments({ userId: u.userId, status: 'ACTIVE' })).toBe(1);
  });

  it('marks past planned blocks MISSED and suggests a re-plan', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const plan = await approvedPlan(u);
    const blockId = plan.blocks[0].id;
    await StudyPlan.updateOne({ _id: plan.id, 'blocks._id': blockId }, { $set: { 'blocks.$.dateStr': day(0), 'blocks.$.startMinute': 0, 'blocks.$.durationMinutes': 5 } });
    // Approved before the block ended: push approvedAt back so the miss counts as new.
    await StudyPlan.updateOne({ _id: plan.id }, { $set: { approvedAt: new Date(Date.parse(`${day(-1)}T00:00:00Z`)) } });

    const r = await authed('get', '/api/planner/plan', u.token);
    expect(r.body.plan.blocks.find(b => b.id === blockId).status).toBe('MISSED');
    expect(r.body.plan.replanSuggested).toBe(true);
  });

  it('skips and moves blocks (a moved block is locked)', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const plan = await approvedPlan(u);
    const [a, b] = plan.blocks.filter(x => x.kind === 'STUDY');

    const skipped = await authed('patch', `/api/planner/blocks/${a.id}`, u.token).send({ action: 'skip' });
    expect(skipped.body.plan.blocks.find(x => x.id === a.id).status).toBe('SKIPPED');

    const moved = await authed('patch', `/api/planner/blocks/${b.id}`, u.token).send({ action: 'move', dateStr: day(3), startMinute: 1380 });
    expect(moved.status).toBe(200);
    expect(moved.body.plan.blocks.find(x => x.id === b.id)).toMatchObject({ dateStr: day(3), startMinute: 1380, locked: true });

    expect((await authed('patch', `/api/planner/blocks/${b.id}`, u.token).send({ action: 'move', dateStr: day(9), startMinute: 600 })).status).toBe(400);   // after deadline
    expect((await authed('patch', `/api/planner/blocks/${b.id}`, u.token).send({ action: 'move', dateStr: day(-1), startMinute: 600 })).status).toBe(400);  // past
  });

  it("can't approve or edit another user's plan", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await allDayWindows(a.token);
    await addTask(a);
    const prev = await authed('post', '/api/planner/preview', a.token);
    expect((await authed('post', `/api/planner/plans/${prev.body.plan.id}/approve`, b.token)).status).toBe(404);
    const plan = await approvedPlan(a);
    expect((await authed('patch', `/api/planner/blocks/${plan.blocks[0].id}`, b.token).send({ action: 'skip' })).status).toBe(404);
  });
});

// ─── Sessions from blocks ────────────────────────────────────────────────────
describe('focus sessions started from plan blocks', () => {
  it('links the session, marks the block DONE and counts minutes toward the task', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    const t = await addTask(u);
    const plan = await approvedPlan(u);
    const block = plan.blocks.find(b => b.kind === 'STUDY');

    const startedAt = new Date(Date.now() - 60 * 60_000);
    const s = await authed('post', '/api/sessions', u.token).send({
      categoryId: u.categoryId, customName: block.taskTitle, plannedDurationSec: block.durationMinutes * 60,
      startedAt: startedAt.toISOString(), planBlockId: block.id,
    });
    expect(s.status).toBe(201);
    expect(s.body.planBlockId).toBe(block.id);
    let p = await authed('get', '/api/planner/plan', u.token);
    expect(p.body.plan.blocks.find(b => b.id === block.id)).toMatchObject({ status: 'IN_PROGRESS', sessionId: s.body.id });

    const end = await authed('patch', `/api/sessions/${s.body.id}/end`, u.token).send({
      status: 'COMPLETED', actualDurationSec: 40 * 60, endedAt: new Date(startedAt.getTime() + 40 * 60_000).toISOString(),
    });
    expect(end.status).toBe(200);
    p = await authed('get', '/api/planner/plan', u.token);
    expect(p.body.plan.blocks.find(b => b.id === block.id).status).toBe('DONE');
    const task = (await authed('get', '/api/planner/tasks', u.token)).body.tasks.find(x => x.id === t.id);
    expect(task).toMatchObject({ completedMinutes: 40, remainingMinutes: 110 });

    // A block can't be started twice.
    const again = await authed('post', '/api/sessions', u.token).send({ categoryId: u.categoryId, plannedDurationSec: 600, planBlockId: block.id });
    expect(again.status).toBe(400);
  });

  it('puts an abandoned block back to PLANNED so it can be retried', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const plan = await approvedPlan(u);
    const block = plan.blocks.filter(b => b.kind === 'STUDY').at(-1);   // latest → still in the future
    const s = await authed('post', '/api/sessions', u.token).send({ categoryId: u.categoryId, plannedDurationSec: 600, planBlockId: block.id });
    await authed('patch', `/api/sessions/${s.body.id}/end`, u.token).send({ status: 'ABANDONED' });
    const p = await authed('get', '/api/planner/plan', u.token);
    expect(p.body.plan.blocks.find(b => b.id === block.id)).toMatchObject({ status: 'PLANNED', sessionId: null });
  });

  it("rejects a planBlockId that isn't in the user's active plan", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await allDayWindows(a.token);
    await addTask(a);
    const plan = await approvedPlan(a);
    const r = await authed('post', '/api/sessions', b.token).send({ categoryId: b.categoryId, plannedDurationSec: 600, planBlockId: plan.blocks[0].id });
    expect(r.status).toBe(400);
    expect(await Session.countDocuments({ userId: b.userId })).toBe(0);
  });
});

// ─── Task edits keep the plan consistent ─────────────────────────────────────
describe('task edits and concurrent changes', () => {
  it('cancelling a task removes its open blocks (no Start buttons left)', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    const t = await addTask(u);
    const plan = await approvedPlan(u);
    const doneId = plan.blocks[0].id;
    await StudyPlan.updateOne({ _id: plan.id, 'blocks._id': doneId }, { $set: { 'blocks.$.status': 'DONE' } });

    await authed('patch', `/api/planner/tasks/${t.id}`, u.token).send({ status: 'CANCELLED' });
    const blocks = (await authed('get', '/api/planner/plan', u.token)).body.plan.blocks;
    expect(blocks.map(b => b.id)).toEqual([doneId]);           // history kept, open blocks gone
  });

  it('changing a task\'s subject moves its blocks to the new subject', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    const t = await addTask(u);
    await approvedPlan(u);
    const work = u.categories.find(c => c.name === 'Work').id;

    await authed('patch', `/api/planner/tasks/${t.id}`, u.token).send({ categoryId: work });
    const blocks = (await authed('get', '/api/planner/plan', u.token)).body.plan.blocks;
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(b => b.categoryId === work)).toBe(true);
  });

  it('keeps a block started between preview and approve', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const plan = await approvedPlan(u);
    const draft = (await authed('post', '/api/planner/preview', u.token)).body.plan;   // new draft first
    const block = plan.blocks.filter(b => b.kind === 'STUDY').at(-1);
    expect(draft.blocks.some(b => b.id === block.id)).toBe(false);                     // unlocked → re-placed

    const s = await authed('post', '/api/sessions', u.token).send({ categoryId: u.categoryId, plannedDurationSec: 600, planBlockId: block.id });
    expect(s.status).toBe(201);
    const approved = await authed('post', `/api/planner/plans/${draft.id}/approve`, u.token);
    expect(approved.body.plan.blocks.find(b => b.id === block.id)).toMatchObject({ status: 'IN_PROGRESS', sessionId: s.body.id });
  });

  it('keeps the user\'s moved block and drops a new block it would overlap (PLAN_CHANGED)', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const plan = await approvedPlan(u);
    const draft = (await authed('post', '/api/planner/preview', u.token)).body.plan;
    const fresh = draft.blocks.find(b => !plan.blocks.some(p => p.id === b.id) && b.kind === 'STUDY');
    const mine = plan.blocks.filter(b => b.kind === 'STUDY').at(-1);

    // After the preview, the user moves one of their blocks onto the slot a
    // NEW draft block took (set directly: in the active plan that slot may
    // hold the old copy of a re-placed block, which the move API would refuse).
    await StudyPlan.updateOne({ _id: plan.id, 'blocks._id': mine.id }, { $set: {
      'blocks.$.dateStr': fresh.dateStr, 'blocks.$.startMinute': fresh.startMinute, 'blocks.$.locked': true,
    } });

    const approved = (await authed('post', `/api/planner/plans/${draft.id}/approve`, u.token)).body.plan;
    expect(approved.blocks.find(b => b.id === mine.id)).toMatchObject({ dateStr: fresh.dateStr, startMinute: fresh.startMinute, locked: true });
    expect(approved.blocks.some(b => b.id === fresh.id)).toBe(false);
    expect(approved.warnings.map(w => w.code)).toContain('PLAN_CHANGED');
    const byDay = new Map();
    for (const b of approved.blocks) byDay.set(b.dateStr, [...(byDay.get(b.dateStr) ?? []), b]);
    for (const list of byDay.values()) {
      list.sort((a, b) => a.startMinute - b.startMinute);
      for (let i = 1; i < list.length; i++) expect(list[i].startMinute).toBeGreaterThanOrEqual(list[i - 1].startMinute + list[i - 1].durationMinutes);
    }
  });

  it('keeps one draft when two previews race, and one active plan when two approvals race', async () => {
    await StudyPlan.init();   // unique partial indexes must exist
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const [p1, p2] = await Promise.all([
      authed('post', '/api/planner/preview', u.token),
      authed('post', '/api/planner/preview', u.token),
    ]);
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);
    expect(await StudyPlan.countDocuments({ userId: u.userId, status: 'DRAFT' })).toBe(1);

    const draft = (await authed('get', '/api/planner/draft', u.token)).body.plan;
    const results = await Promise.all([
      authed('post', `/api/planner/plans/${draft.id}/approve`, u.token),
      authed('post', `/api/planner/plans/${draft.id}/approve`, u.token),
    ]);
    // Either both succeed on the same plan (the second finishes the first's
    // approval) or the second gets 404 — never two active plans.
    for (const r of results) expect([200, 404]).toContain(r.status);
    for (const r of results.filter(x => x.status === 200)) expect(r.body.plan.id).toBe(draft.id);
    expect(await StudyPlan.countDocuments({ userId: u.userId, status: 'ACTIVE' })).toBe(1);
  });

  it('finishes an approval that stopped after the old plan was archived', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const old = await approvedPlan(u);
    const draft = (await authed('post', '/api/planner/preview', u.token)).body.plan;
    // Simulate a crash between "archive old" and "activate draft".
    await StudyPlan.updateOne({ _id: old.id }, { $set: { status: 'ARCHIVED', supersededBy: draft.id } });

    const r = await authed('get', '/api/planner/plan', u.token);
    expect(r.body.plan).toMatchObject({ id: draft.id, status: 'ACTIVE' });
    expect(await StudyPlan.countDocuments({ userId: u.userId, status: 'DRAFT' })).toBe(0);
  });

  it('marks the right block MISSED even when another task was deleted meanwhile', async () => {
    const { refreshMissed } = await import('../services/planner/planService.js');
    const u = await makeUser();
    await allDayWindows(u.token);
    const a = await addTask(u, { title: 'A', deadline: day(3), kind: 'STUDY', estimatedMinutes: 90 });   // earlier deadline → earlier blocks
    const b = await addTask(u, { title: 'B', deadline: day(6), kind: 'STUDY', estimatedMinutes: 90 });
    const plan = await approvedPlan(u);
    const target = plan.blocks.find(x => x.taskId === b.id);
    await StudyPlan.updateOne({ _id: plan.id, 'blocks._id': target.id },
      { $set: { 'blocks.$.dateStr': day(0), 'blocks.$.startMinute': 0, 'blocks.$.durationMinutes': 5 } });

    const stale = await StudyPlan.findById(plan.id);              // loaded before the deletion
    await authed('delete', `/api/planner/tasks/${a.id}`, u.token); // shifts block positions
    await refreshMissed(stale);

    const fresh = await StudyPlan.findById(plan.id).lean();
    expect(fresh.blocks.find(x => String(x._id) === target.id).status).toBe('MISSED');
    expect(fresh.blocks.filter(x => x.status === 'MISSED')).toHaveLength(1);
    expect(fresh.blocks.some(x => String(x.taskId) === a.id)).toBe(false);
  });
});

// ─── Calendar + cleanup ──────────────────────────────────────────────────────
describe('calendar and cleanup', () => {
  it('returns sessions, deadlines and plan blocks for a date range', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    await approvedPlan(u);
    const r = await authed('get', `/api/planner/calendar?from=${day(-3)}&to=${day(10)}`, u.token);
    expect(r.status).toBe(200);
    expect(r.body.today).toBe(today);
    expect(r.body.deadlines).toHaveLength(1);
    expect(r.body.blocks.length).toBeGreaterThan(0);
    expect(Array.isArray(r.body.sessions)).toBe(true);
    expect((await authed('get', `/api/planner/calendar?from=${day(0)}&to=${day(200)}`, u.token)).status).toBe(400);
  });

  it('deleting a category removes its tasks and open blocks', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    const plan = await approvedPlan(u);
    expect(plan.blocks.length).toBeGreaterThan(0);
    await authed('delete', `/api/user/categories/${u.categoryId}`, u.token);
    expect(await StudyTask.countDocuments({ userId: u.userId })).toBe(0);
    expect((await authed('get', '/api/planner/plan', u.token)).body.plan.blocks).toEqual([]);
  });

  it('account deletion removes planner data', async () => {
    const u = await makeUser();
    await allDayWindows(u.token);
    await addTask(u);
    await approvedPlan(u);
    await authed('delete', '/api/user/me', u.token);
    expect(await StudyTask.countDocuments({ userId: u.userId })).toBe(0);
    expect(await StudyPlan.countDocuments({ userId: u.userId })).toBe(0);
  });
});
