// Study Planner API — mounted at /api/planner (auth required).
// See docs/planner.md (backend) and docs/planner-frontend.md (app handoff).
//
// Ownership: every lookup filters on the authenticated user's id; another
// user's task or plan is a 404, the same as one that doesn't exist.
import express from 'express';
import rateLimit from 'express-rate-limit';
import auth from '../middleware/auth.js';
import asyncHandler from '../middleware/asyncHandler.js';
import {
  requireString, requireInt, requireEnum, requireObjectId, requireDateStr, badRequest,
} from '../middleware/validate.js';
import StudyTask, { TASK_KINDS, MAX_OPEN_TASKS } from '../models/StudyTask.js';
import StudyPlan from '../models/StudyPlan.js';
import User from '../models/User.js';
import { parseStudyRequest, MAX_PARSE_TEXT } from '../services/planner/ai.js';
import {
  buildDraft, approveDraft, getActivePlan, replanSuggested, editBlock, deleteTask, onTaskUpdated,
  calendarRange, planRecord, plannerSettingsOf, MAX_CALENDAR_DAYS,
} from '../services/planner/planService.js';
import { resolveTimezone, userTodayStr, shiftDateStr, diffDays } from '../utils/datetime.js';

const router = express.Router();
router.use(auth);

// Each of these can call the LLM; cap bursts per user on top of the daily
// AI quota (llm/userQuota.js). Disabled in tests.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `planner:${req.user._id}`,
  skip: () => process.env.NODE_ENV === 'test',
  message: { message: 'Too many planner requests, please slow down' },
});

function onlyKeys(body, allowed) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw badRequest(`Unexpected field(s): ${extra.join(', ')}`);
  return body;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isRealDate = (s) => shiftDateStr(s, 0) === s;

function readDeadline(v, today, field = 'deadline') {
  requireDateStr(v, { field });
  if (!isRealDate(v)) throw badRequest(`${field} is not a real calendar date`);
  if (v < today) throw badRequest(`${field} must not be in the past`);
  if (v > shiftDateStr(today, 365)) throw badRequest(`${field} must be within a year`);
  return v;
}

function readCategory(user, v) {
  const id = requireString(v, { min: 1, max: 100, field: 'categoryId' });
  if (!user.categories?.some(c => c.id === id)) throw badRequest('categoryId is not one of your categories');
  return id;
}

const TASK_FIELDS = ['title', 'categoryId', 'kind', 'deadline', 'deadlineTime', 'difficulty', 'estimatedMinutes', 'source'];

/** Validate a task body. `partial` = PATCH (only given fields, plus status). */
function readTask(user, raw, { today, partial = false, field = 'task' } = {}) {
  const body = onlyKeys(raw, partial ? [...TASK_FIELDS.filter(f => f !== 'source'), 'status'] : TASK_FIELDS);
  const out = {};
  const has = (k) => body[k] !== undefined;
  const need = (k) => { if (!partial && !has(k)) throw badRequest(`${field}.${k} is required`); return has(k); };

  if (need('title')) {
    out.title = requireString(body.title, { min: 1, max: 100, field: `${field}.title` }).trim();
    if (!out.title) throw badRequest(`${field}.title must not be empty`);
  }
  if (need('categoryId')) out.categoryId = readCategory(user, body.categoryId);
  if (need('deadline')) out.deadline = readDeadline(body.deadline, today, `${field}.deadline`);
  if (need('estimatedMinutes')) out.estimatedMinutes = requireInt(body.estimatedMinutes, { min: 15, max: 6000, field: `${field}.estimatedMinutes` });
  if (has('kind')) out.kind = requireEnum(body.kind, TASK_KINDS, { field: `${field}.kind` });
  if (has('difficulty')) out.difficulty = requireInt(body.difficulty, { min: 1, max: 3, field: `${field}.difficulty` });
  if (has('deadlineTime')) {
    if (body.deadlineTime !== null && (typeof body.deadlineTime !== 'string' || !TIME_RE.test(body.deadlineTime)))
      throw badRequest(`${field}.deadlineTime must be "HH:MM" or null`);
    out.deadlineTime = body.deadlineTime;
  }
  if (has('source')) out.source = requireEnum(body.source, ['AI', 'MANUAL'], { field: `${field}.source` });
  if (partial && has('status')) out.status = requireEnum(body.status, ['OPEN', 'DONE', 'CANCELLED'], { field: 'status' });
  return out;
}

// ─── Settings: GET/PUT /api/planner/settings ─────────────────────────────────

router.get('/settings', asyncHandler(async (req, res) => {
  res.json(plannerSettingsOf(req.user));
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const body = onlyKeys(req.body, ['windows', 'maxDailyMinutes', 'sessionLength', 'breakBetween', 'noStudyAfter']);
  const updates = {};
  if (body.windows !== undefined) {
    if (!Array.isArray(body.windows) || body.windows.length > 28) throw badRequest('windows must be an array of at most 28 items');
    updates['settings.planner.windows'] = body.windows.map((w, i) => {
      const x = onlyKeys(w, ['weekday', 'start', 'end']);
      const weekday = requireInt(x.weekday, { min: 0, max: 6, field: `windows[${i}].weekday` });
      const start = requireInt(x.start, { min: 0, max: 1439, field: `windows[${i}].start` });
      const end = requireInt(x.end, { min: 1, max: 1440, field: `windows[${i}].end` });
      if (end <= start) throw badRequest(`windows[${i}]: end must be after start`);
      return { weekday, start, end };
    });
  }
  const ints = { maxDailyMinutes: [30, 960], sessionLength: [15, 180], breakBetween: [0, 60], noStudyAfter: [60, 1440] };
  for (const [k, [min, max]] of Object.entries(ints)) {
    if (body[k] !== undefined) updates[`settings.planner.${k}`] = requireInt(body[k], { min, max, field: k });
  }
  if (!Object.keys(updates).length) throw badRequest('No planner settings provided');
  const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { returnDocument: 'after', runValidators: true });
  res.json(plannerSettingsOf(user));
}));

// ─── POST /api/planner/parse  { text } → draft tasks (nothing saved) ─────────

router.post('/parse', aiLimiter, asyncHandler(async (req, res) => {
  const body = onlyKeys(req.body, ['text']);
  const text = requireString(body.text, { min: 1, max: MAX_PARSE_TEXT, field: 'text' }).trim();
  if (!text) throw badRequest('text must not be empty');
  const tz = resolveTimezone(req.user);
  const out = await parseStudyRequest({
    text, today: userTodayStr(tz), tz, categories: req.user.categories ?? [], userId: req.user._id, log: req.log,
  });
  res.json({
    tasks: out.tasks,
    questions: out.questions,
    source: out.source,
    // 'daily_limit' lets the app say why parsing fell back to the form.
    unavailableReason: out.source === 'fallback' ? (out.reason === 'user_daily_limit' ? 'daily_limit' : 'service_unavailable') : null,
  });
}));

// ─── Tasks ───────────────────────────────────────────────────────────────────

router.get('/tasks', asyncHandler(async (req, res) => {
  const status = req.query.status === undefined ? 'OPEN' : requireEnum(req.query.status, ['OPEN', 'DONE', 'CANCELLED', 'ALL'], { field: 'status' });
  const filter = { userId: req.user._id, ...(status === 'ALL' ? {} : { status }) };
  const tasks = await StudyTask.find(filter).sort({ deadline: 1, createdAt: 1 }).limit(200);
  res.json({ tasks: tasks.map(t => StudyTask.toRecord(t)) });
}));

// Body: { tasks: [ {title, categoryId, kind?, deadline, deadlineTime?, difficulty?, estimatedMinutes, source?} ] }
router.post('/tasks', asyncHandler(async (req, res) => {
  const body = onlyKeys(req.body, ['tasks']);
  if (!Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 30)
    throw badRequest('tasks must be an array of 1-30 tasks');
  const today = userTodayStr(resolveTimezone(req.user));
  const docs = body.tasks.map((t, i) => ({ ...readTask(req.user, t, { today, field: `tasks[${i}]` }), userId: req.user._id }));

  const open = await StudyTask.countDocuments({ userId: req.user._id, status: 'OPEN' });
  if (open + docs.length > MAX_OPEN_TASKS)
    return res.status(409).json({ message: `You can have up to ${MAX_OPEN_TASKS} open tasks. Finish or delete some first.` });

  const created = await StudyTask.insertMany(docs);
  res.status(201).json({ tasks: created.map(t => StudyTask.toRecord(t)) });
}));

router.patch('/tasks/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, { field: 'task id' });
  const today = userTodayStr(resolveTimezone(req.user));
  const updates = readTask(req.user, req.body, { today, partial: true });
  if (!Object.keys(updates).length) throw badRequest('No task fields provided');
  const task = await StudyTask.findOneAndUpdate({ _id: id, userId: req.user._id }, { $set: updates }, { returnDocument: 'after', runValidators: true });
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (updates.status !== undefined || updates.categoryId !== undefined) await onTaskUpdated(req.user._id, task);
  res.json({ task: StudyTask.toRecord(task) });
}));

router.delete('/tasks/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, { field: 'task id' });
  if (!(await deleteTask(req.user._id, id))) return res.status(404).json({ message: 'Task not found' });
  res.json({ deleted: true });
}));

// ─── Plans ───────────────────────────────────────────────────────────────────

// POST /api/planner/preview → a new DRAFT (replaces any earlier draft).
router.post('/preview', aiLimiter, asyncHandler(async (req, res) => {
  onlyKeys(req.body, []);
  const draft = await buildDraft(req.user, { reason: 'PREVIEW', log: req.log });
  res.status(201).json({ plan: await planRecord(req.user._id, draft) });
}));

// POST /api/planner/replan → a new DRAFT that keeps done/moved blocks.
router.post('/replan', aiLimiter, asyncHandler(async (req, res) => {
  onlyKeys(req.body, []);
  const draft = await buildDraft(req.user, { reason: 'REPLAN', log: req.log });
  res.status(201).json({ plan: await planRecord(req.user._id, draft) });
}));

router.get('/draft', asyncHandler(async (req, res) => {
  const draft = await StudyPlan.findOne({ userId: req.user._id, status: 'DRAFT' });
  res.json({ plan: await planRecord(req.user._id, draft) });
}));

router.delete('/draft', asyncHandler(async (req, res) => {
  const r = await StudyPlan.deleteMany({ userId: req.user._id, status: 'DRAFT' });
  res.json({ deleted: r.deletedCount > 0 });
}));

router.post('/plans/:id/approve', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, { field: 'plan id' });
  const plan = await approveDraft(req.user._id, id);
  if (!plan) return res.status(404).json({ message: 'Draft plan not found' });
  res.json({ plan: await planRecord(req.user._id, plan, { replanSuggested: false }) });
}));

// GET /api/planner/plan → the ACTIVE plan (missed blocks refreshed) or null.
router.get('/plan', asyncHandler(async (req, res) => {
  const plan = await getActivePlan(req.user._id);
  res.json({ plan: await planRecord(req.user._id, plan, { replanSuggested: replanSuggested(plan) }) });
}));

// PATCH /api/planner/blocks/:blockId  { action: 'skip' } | { action: 'move', dateStr, startMinute }
router.patch('/blocks/:blockId', asyncHandler(async (req, res) => {
  const blockId = requireObjectId(req.params.blockId, { field: 'block id' });
  const body = onlyKeys(req.body, ['action', 'dateStr', 'startMinute']);
  const action = requireEnum(body.action, ['skip', 'move'], { field: 'action' });
  let edit = { action };
  if (action === 'move') {
    const dateStr = requireDateStr(body.dateStr);
    if (!isRealDate(dateStr)) throw badRequest('dateStr is not a real calendar date');
    const startMinute = requireInt(body.startMinute, { min: 0, max: 1435, field: 'startMinute' });
    if (startMinute % 5) throw badRequest('startMinute must be a multiple of 5');
    edit = { action, dateStr, startMinute };
  }
  const plan = await editBlock(req.user, blockId, edit);
  if (!plan) return res.status(404).json({ message: 'Block not found in your active plan' });
  res.json({ plan: await planRecord(req.user._id, plan, { replanSuggested: replanSuggested(plan) }) });
}));

// ─── GET /api/planner/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────────
// One feed for the combined Calendar screen: past sessions + deadlines + blocks.
router.get('/calendar', asyncHandler(async (req, res) => {
  const from = requireDateStr(req.query.from, { field: 'from' });
  const to = requireDateStr(req.query.to, { field: 'to' });
  if (!isRealDate(from) || !isRealDate(to)) throw badRequest('from and to must be real calendar dates');
  if (from > to) throw badRequest('from must be on or before to');
  if (diffDays(from, to) + 1 > MAX_CALENDAR_DAYS) throw badRequest(`range must span at most ${MAX_CALENDAR_DAYS} days`);
  res.json(await calendarRange(req.user, from, to));
}));

export default router;
