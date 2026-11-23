// Study Planner: everything between the routes and the pure scheduler.
//
// Lifecycle
//   preview  → builds a DRAFT from open tasks (replacing any earlier draft).
//              Blocks the user already acted on (done, in progress, missed,
//              skipped, or moved = locked) are KEPT, with their ids, so links
//              to focus sessions survive; only future unlocked blocks are
//              re-placed.
//   approve  → DRAFT becomes ACTIVE, the previous ACTIVE is ARCHIVED.
//   missed   → on read, PLANNED blocks whose end time has passed become
//              MISSED; `replanSuggested` tells the app to offer a new draft.
//   sessions → POST /api/sessions with planBlockId links a focus session to a
//              block (IN_PROGRESS). Ending it marks the block DONE (completed)
//              or back to PLANNED/MISSED (abandoned), and adds the focus
//              minutes to the task.
//
// Every query is scoped to the authenticated user's id.
import mongoose from 'mongoose';
import StudyTask from '../../models/StudyTask.js';
import StudyPlan from '../../models/StudyPlan.js';
import Session, { actualSecOf } from '../../models/Session.js';
import { schedule, DEFAULT_HOUR_SCORES, MAX_PLAN_DAYS } from './scheduler.js';
import { planSummary, explainPlan } from './ai.js';
import { badRequest } from '../../middleware/validate.js';
import {
  resolveTimezone, userTodayStr, toUserDate, localDayStartUtc, localHourOf, shiftDateStr,
} from '../../utils/datetime.js';
import logger from '../../utils/logger.js';

const HISTORY_DAYS = 30;
const MIN_SESSIONS_FOR_HISTORY = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** UTC instant a block ends, in the plan's zone. */
export function blockEndsAt(block, tz) {
  return new Date(localDayStartUtc(block.dateStr, tz).getTime() + (block.startMinute + block.durationMinutes) * 60_000);
}

export function plannerSettingsOf(user) {
  const p = user.settings?.planner ?? {};
  return {
    windows:         (p.windows ?? []).map(w => ({ weekday: w.weekday, start: w.start, end: w.end })),
    maxDailyMinutes: p.maxDailyMinutes ?? 240,
    sessionLength:   p.sessionLength ?? 50,
    breakBetween:    p.breakBetween ?? 10,
    noStudyAfter:    p.noStudyAfter ?? 1380,
  };
}

/**
 * Focus quality (0..1) per local hour from the last 30 days of completed
 * sessions, blended with a default curve so a few sessions don't dominate.
 */
export async function hourScoresFor(userId, tz) {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
  const sessions = await Session.find(
    { userId, status: 'COMPLETED', startedAt: { $gte: since }, focusScore: { $ne: null } },
    { startedAt: 1, focusScore: 1, timezone: 1 },
  ).lean();
  if (sessions.length < MIN_SESSIONS_FOR_HISTORY) return { scores: [...DEFAULT_HOUR_SCORES], basedOnHistory: false };

  const sum = Array(24).fill(0);
  const n = Array(24).fill(0);
  for (const s of sessions) {
    const h = localHourOf(s.startedAt, s.timezone || tz);
    sum[h] += s.focusScore / 100;
    n[h] += 1;
  }
  const PRIOR = 2;   // pseudo-sessions of the default curve per hour
  const scores = DEFAULT_HOUR_SCORES.map((d, h) => (n[h] ? (sum[h] + PRIOR * d) / (n[h] + PRIOR) : d));
  return { scores, basedOnHistory: true };
}

async function taskTitlesFor(userId, plan) {
  const ids = [...new Set(plan.blocks.map(b => String(b.taskId)))];
  const tasks = await StudyTask.find({ userId, _id: { $in: ids } }, { title: 1 }).lean();
  return Object.fromEntries(tasks.map(t => [String(t._id), t.title]));
}

export async function planRecord(userId, plan, extra = {}) {
  if (!plan) return null;
  return { ...StudyPlan.toRecord(plan, await taskTitlesFor(userId, plan)), ...extra };
}

// ─── Missed blocks ───────────────────────────────────────────────────────────

/**
 * Mark PLANNED blocks whose end has passed as MISSED.
 *
 * Block writes in this module always target blocks BY ID (arrayFilters or
 * 'blocks._id' positional), never by array index via doc.save(): a concurrent
 * $pull (task/category deletion) shifts indexes, and an index-based write
 * would then change the wrong block.
 */
export async function refreshMissed(plan, now = new Date()) {
  const ids = plan.blocks
    .filter(b => b.status === 'PLANNED' && blockEndsAt(b, plan.timezone) <= now)
    .map(b => b._id);
  if (!ids.length) return plan;
  await StudyPlan.updateOne(
    { _id: plan._id },
    { $set: { 'blocks.$[b].status': 'MISSED' } },
    { arrayFilters: [{ 'b._id': { $in: ids }, 'b.status': 'PLANNED' }] },
  );
  const idSet = new Set(ids.map(String));
  for (const b of plan.blocks) if (idSet.has(String(b._id)) && b.status === 'PLANNED') b.status = 'MISSED';
  return plan;
}

/** True when blocks were missed since the plan was approved (offer a re-plan). */
export function replanSuggested(plan) {
  if (!plan || plan.status !== 'ACTIVE') return false;
  const since = plan.approvedAt ?? plan.generatedAt;
  return plan.blocks.some(b => b.status === 'MISSED' && blockEndsAt(b, plan.timezone) > since);
}

export async function getActivePlan(userId) {
  const plan = await StudyPlan.findOne({ userId, status: 'ACTIVE' });
  if (plan) return refreshMissed(plan);

  // No ACTIVE plan: if an approval was interrupted after the old plan was
  // archived, finish it now so the user isn't left without a plan.
  const orphan = await StudyPlan.findOne({ userId, status: 'ARCHIVED', supersededBy: { $ne: null } })
    .sort({ updatedAt: -1 });
  if (orphan && await StudyPlan.exists({ _id: orphan.supersededBy, userId, status: 'DRAFT' })) {
    return approveDraft(userId, orphan.supersededBy);
  }
  return null;
}

// ─── Draft (preview / re-plan) ───────────────────────────────────────────────

/**
 * Build and store a DRAFT plan for `user`. Returns the draft document.
 * @param reason 'PREVIEW' | 'REPLAN'
 */
export async function buildDraft(user, { reason = 'PREVIEW', log = logger, now = new Date() } = {}) {
  const userId = user._id;
  const tz = resolveTimezone(user);
  const today = userTodayStr(tz);
  const local = toUserDate(now, tz);
  const nowMinute = local.hour * 60 + local.minute;
  const settings = plannerSettingsOf(user);

  const active = await getActivePlan(userId);

  // Blocks to keep: anything the user acted on or that is already behind us.
  const kept = (active?.blocks ?? []).filter(b => b.status !== 'PLANNED' || b.locked);
  const futureKept = kept.filter(b => (b.status === 'PLANNED' || b.status === 'IN_PROGRESS') && b.dateStr >= today);

  const tasks = await StudyTask.find({
    userId, status: 'OPEN', deadline: { $gte: today, $lte: shiftDateStr(today, MAX_PLAN_DAYS) },
  }).lean();

  const reservedByTask = new Map();
  const reviewByTask = new Set();
  for (const b of futureKept) {
    const k = String(b.taskId);
    reservedByTask.set(k, (reservedByTask.get(k) ?? 0) + b.durationMinutes);
    if (b.kind === 'REVIEW') reviewByTask.add(k);
  }

  const schedTasks = tasks.map(t => ({
    id:               String(t._id),
    categoryId:       t.categoryId,
    kind:             t.kind,
    deadline:         t.deadline,
    difficulty:       t.difficulty,
    remainingMinutes: Math.max(0, t.estimatedMinutes - t.completedMinutes - (reservedByTask.get(String(t._id)) ?? 0)),
    hasReview:        reviewByTask.has(String(t._id)),
  }));

  const { scores } = await hourScoresFor(userId, tz);
  const { blocks, warnings } = schedule({
    tasks: schedTasks,
    settings,
    hourScores: scores,
    busy: futureKept.map(b => ({ dateStr: b.dateStr, startMinute: b.startMinute, durationMinutes: b.durationMinutes })),
    today,
    nowMinute,
  });

  const summary = planSummary({
    blocks: [...futureKept.map(b => b.toObject()), ...blocks],
    warnings,
    tasks: tasks.map(t => ({ id: String(t._id), title: t.title, deadline: t.deadline })),
    today,
  });
  const { explanation, source } = await explainPlan({ summary, userId, log });

  const doc = {
    userId,
    status: 'DRAFT',
    reason,
    timezone: tz,
    generatedAt: now,
    explanation,
    explanationSource: source,
    warnings: warnings.map(w => ({ ...w, taskId: w.taskId ? new mongoose.Types.ObjectId(w.taskId) : null })),
    blocks: [
      ...kept.map(b => b.toObject()),                       // same _id → session links survive
      ...blocks.map(b => ({ ...b, taskId: new mongoose.Types.ObjectId(b.taskId), status: 'PLANNED' })),
    ],
  };
  // One draft per user (unique index). Two previews racing: the later one
  // replaces the earlier instead of failing.
  for (let attempt = 0; ; attempt++) {
    await StudyPlan.deleteMany({ userId, status: 'DRAFT' });
    try {
      return await StudyPlan.create(doc);
    } catch (err) {
      if (err?.code !== 11000 || attempt >= 2) throw err;
    }
  }
}

/** A block the user acted on: never re-placed by the planner. */
const isFixed = (b) => b.status !== 'PLANNED' || b.locked;
const overlaps = (a, b) => a.dateStr === b.dateStr
  && a.startMinute < b.startMinute + b.durationMinutes && b.startMinute < a.startMinute + a.durationMinutes;

/**
 * DRAFT → ACTIVE (previous ACTIVE → ARCHIVED). Returns the plan or null.
 *
 * Order: merge → archive the old plan (with supersededBy = draft) → activate
 * the draft. If the server stops between the last two steps, getActivePlan()
 * sees the archived plan's supersededBy and calls this again to finish.
 */
export async function approveDraft(userId, planId) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await approveOnce(userId, planId);
    } catch (err) {
      // A task deletion shifted the draft's blocks while we merged: retry on
      // fresh documents. Racing approvals: the unique index stops the second.
      if (err?.name === 'VersionError' && attempt < 2) continue;
      if (err?.code === 11000) return null;
      throw err;
    }
  }
}

async function approveOnce(userId, planId) {
  const draft = await StudyPlan.findOne({ _id: planId, userId, status: 'DRAFT' });
  if (!draft) return null;

  const previous = await StudyPlan.findOne({ userId, status: 'ACTIVE' })
    ?? await StudyPlan.findOne({ userId, status: 'ARCHIVED', supersededBy: draft._id });

  if (previous) {
    // What happened to kept blocks since the preview (a session finished, a
    // block was missed or moved) wins over the draft's copy.
    const current = new Map(previous.blocks.map(b => [String(b._id), b]));
    const inDraft = new Set(draft.blocks.map(b => String(b._id)));
    for (const b of draft.blocks) {
      const c = current.get(String(b._id));
      if (c) {
        Object.assign(b, {
          status: c.status, sessionId: c.sessionId, locked: c.locked,
          dateStr: c.dateStr, startMinute: c.startMinute, durationMinutes: c.durationMinutes,
        });
      }
    }
    // Blocks the user acted on AFTER the preview were unlocked PLANNED blocks
    // then, so the draft dropped them. Carry them over so a running or
    // finished session keeps its block.
    for (const c of previous.blocks) {
      if (!inDraft.has(String(c._id)) && isFixed(c)) draft.blocks.push(c.toObject());
    }

    // A carried or moved block may now sit on top of a newly placed one.
    // The user's block wins; the new one is dropped and the plan says so.
    const fixed = draft.blocks.filter(isFixed);
    const clash = draft.blocks.filter(b => !isFixed(b) && fixed.some(f => overlaps(f, b)));
    if (clash.length) {
      for (const b of clash) draft.blocks.pull(b._id);
      draft.warnings.push({
        code: 'PLAN_CHANGED', taskId: null, minutes: clash.reduce((a, b) => a + b.durationMinutes, 0),
        message: 'Some sessions changed while you were reviewing this plan. Tap "Update plan" to place the rest.',
      });
    }

    if (previous.status === 'ACTIVE') {
      const r = await StudyPlan.updateOne(
        { _id: previous._id, status: 'ACTIVE' },
        { $set: { status: 'ARCHIVED', supersededBy: draft._id } },
      );
      if (r.matchedCount === 0) return null;   // another approval won
    }
  }

  draft.status = 'ACTIVE';
  draft.approvedAt = new Date();
  await draft.save();
  return refreshMissed(draft);
}

// ─── Block edits ─────────────────────────────────────────────────────────────

const BLOCK_RANGE_ERR = 'The block must stay inside one day (00:00–24:00).';

/** Move (and lock) or skip a PLANNED/MISSED block of the ACTIVE plan. */
export async function editBlock(user, blockId, { action, dateStr, startMinute }) {
  const plan = await getActivePlan(user._id);
  const block = plan?.blocks.id(blockId);
  if (!block) return null;
  if (!['PLANNED', 'MISSED'].includes(block.status))
    throw badRequest(`Only planned or missed blocks can be changed (this one is ${block.status}).`);

  let set;
  if (action === 'skip') {
    set = { 'blocks.$.status': 'SKIPPED' };
  } else {
    const tz = plan.timezone;
    const today = userTodayStr(tz);
    if (dateStr < today) throw badRequest('A block cannot be moved into the past.');
    if (startMinute + block.durationMinutes > 1440) throw badRequest(BLOCK_RANGE_ERR);
    const task = await StudyTask.findOne({ _id: block.taskId, userId: user._id }, { deadline: 1 }).lean();
    if (task && dateStr >= task.deadline) throw badRequest(`The block must be before the deadline (${task.deadline}).`);
    const end = startMinute + block.durationMinutes;
    const clash = plan.blocks.find(o => !o._id.equals(block._id) && o.dateStr === dateStr
      && ['PLANNED', 'IN_PROGRESS', 'DONE'].includes(o.status)
      && startMinute < o.startMinute + o.durationMinutes && o.startMinute < end);
    if (clash) throw badRequest('That time overlaps another block.');
    const candidate = { dateStr, startMinute, durationMinutes: block.durationMinutes };
    if (blockEndsAt(candidate, tz) <= new Date()) throw badRequest('A block cannot be moved into the past.');
    set = { 'blocks.$.dateStr': dateStr, 'blocks.$.startMinute': startMinute, 'blocks.$.status': 'PLANNED', 'blocks.$.locked': true };
  }
  // By id, and only if the block is still editable (a session may have
  // started from it meanwhile).
  const r = await StudyPlan.updateOne(
    { _id: plan._id, blocks: { $elemMatch: { _id: block._id, status: { $in: ['PLANNED', 'MISSED'] } } } },
    { $set: set },
  );
  if (r.matchedCount === 0) throw badRequest('This block changed meanwhile. Refresh and try again.');
  return StudyPlan.findById(plan._id);
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

// $pull shifts array indexes, so it also bumps __v: any concurrent
// index-based doc.save() on the same plan then fails loudly (VersionError)
// instead of writing to the wrong block.
const pullBlocks = (userId, match) => StudyPlan.updateMany(
  { userId, status: { $in: ['DRAFT', 'ACTIVE'] } },
  { $pull: { blocks: match }, $inc: { __v: 1 } },
);

/** Remove a task and its not-yet-done blocks from the user's draft/active plans. */
export async function deleteTask(userId, taskId) {
  const r = await StudyTask.deleteOne({ _id: taskId, userId });
  if (r.deletedCount === 0) return false;
  await pullBlocks(userId, { taskId: new mongoose.Types.ObjectId(String(taskId)), status: { $ne: 'DONE' } });
  return true;
}

/**
 * A task was edited. Finished or cancelled → its open blocks leave the plan
 * (no more Start buttons for it). New subject → its blocks follow, so
 * sessions started from them and later category deletion use the new one.
 */
export async function onTaskUpdated(userId, task) {
  const taskId = task._id;
  if (task.status !== 'OPEN') {
    await pullBlocks(userId, { taskId, status: { $in: ['PLANNED', 'MISSED'] } });
  }
  await StudyPlan.updateMany(
    { userId, status: { $in: ['DRAFT', 'ACTIVE'] }, blocks: { $elemMatch: { taskId, categoryId: { $ne: task.categoryId } } } },
    { $set: { 'blocks.$[b].categoryId': task.categoryId } },
    { arrayFilters: [{ 'b.taskId': taskId }] },
  );
}

/** A category (subject) was deleted: drop its tasks and their open blocks. */
export async function onCategoryDeleted(userId, categoryId) {
  await StudyTask.deleteMany({ userId, categoryId });
  await pullBlocks(userId, { categoryId, status: { $ne: 'DONE' } });
}

// ─── Focus-session hooks (called from routes/sessions.js) ────────────────────

/**
 * Validate that `planBlockId` is a startable block of the user's ACTIVE plan.
 * Returns the block's task title (for a default session name). Throws 400.
 */
export async function assertStartableBlock(userId, planBlockId) {
  const plan = await getActivePlan(userId);
  const block = plan?.blocks.id(planBlockId);
  if (!block) throw badRequest('planBlockId is not a block of your active study plan');
  if (!['PLANNED', 'MISSED'].includes(block.status))
    throw badRequest(`This plan block is already ${block.status}`);
  const task = await StudyTask.findOne({ _id: block.taskId, userId }, { title: 1 }).lean();
  return { block, taskTitle: task?.title ?? null };
}

/** Session created from a block → block IN_PROGRESS. Best effort (never throws). */
export async function linkSessionToBlock(userId, planBlockId, sessionId, log = logger) {
  try {
    await StudyPlan.updateOne(
      { userId, status: 'ACTIVE', 'blocks._id': planBlockId },
      { $set: { 'blocks.$.status': 'IN_PROGRESS', 'blocks.$.sessionId': sessionId } },
    );
  } catch (err) {
    log.warn({ err }, '[planner] failed to link session to block');
  }
}

/**
 * Session from a block ended. COMPLETED → block DONE; ABANDONED → back to
 * PLANNED (or MISSED if its time has passed) so it can be retried. Focus
 * minutes count toward the task either way. Best effort (never throws).
 */
export async function onPlannedSessionEnded(session, log = logger) {
  if (!session?.planBlockId) return;
  try {
    const plan = await StudyPlan.findOne({ userId: session.userId, 'blocks._id': session.planBlockId, status: { $in: ['ACTIVE', 'ARCHIVED'] } })
      .sort({ status: 1 });   // ACTIVE before ARCHIVED
    const block = plan?.blocks.id(session.planBlockId);
    if (!block) return;

    const status = session.status === 'COMPLETED' ? 'DONE'
      : blockEndsAt(block, plan.timezone) <= new Date() ? 'MISSED' : 'PLANNED';
    await StudyPlan.updateOne(
      { _id: plan._id, 'blocks._id': block._id },
      { $set: {
        'blocks.$.status': status,
        ...(status === 'DONE' ? {} : { 'blocks.$.sessionId': null }),
      } },
    );

    const minutes = Math.round((actualSecOf(session) ?? 0) / 60);
    if (minutes > 0) {
      const task = await StudyTask.findOneAndUpdate(
        { _id: block.taskId, userId: session.userId },
        { $inc: { completedMinutes: minutes } },
        { returnDocument: 'after' },
      );
      if (task && task.status === 'OPEN' && task.completedMinutes >= task.estimatedMinutes) {
        task.status = 'DONE';
        await task.save();
      }
    }
  } catch (err) {
    log.warn({ err }, '[planner] failed to update block after session end');
  }
}

// ─── Combined calendar (history + upcoming) ──────────────────────────────────

export const MAX_CALENDAR_DAYS = 92;

/** Past sessions, deadlines and plan blocks between two local dates (inclusive). */
export async function calendarRange(user, from, to) {
  const userId = user._id;
  const tz = resolveTimezone(user);
  const [sessions, tasks, plan] = await Promise.all([
    Session.find({ userId, dateStr: { $gte: from, $lte: to }, status: { $in: ['COMPLETED', 'ABANDONED', 'ACTIVE'] } })
      .sort({ startedAt: 1 }),
    StudyTask.find({ userId, deadline: { $gte: from, $lte: to }, status: { $ne: 'CANCELLED' } }).sort({ deadline: 1 }),
    getActivePlan(userId),
  ]);
  const titles = plan ? await taskTitlesFor(userId, plan) : {};
  const blocks = (plan?.blocks ?? [])
    .filter(b => b.dateStr >= from && b.dateStr <= to)
    .map(b => StudyPlan.blockRecord(b, titles))
    .sort((a, b) => (a.dateStr === b.dateStr ? a.startMinute - b.startMinute : a.dateStr < b.dateStr ? -1 : 1));

  return {
    from, to, today: userTodayStr(tz),
    sessions:  sessions.map(s => Session.toFrontendRecord(s, tz)),
    deadlines: tasks.map(t => StudyTask.toRecord(t)),
    blocks,
    replanSuggested: replanSuggested(plan),
  };
}
