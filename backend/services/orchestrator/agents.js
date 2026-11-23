// Agents for the AI assistant orchestrator. Each is a plain async function
// with a fixed result shape: { agent, status: 'ok'|'unavailable', ... }.
//
//   focusAgent        → the AI Focus Coach (grounded tool calling, read-only)
//   plannerAgent      → reads new deadlines from the message (AI parse) or
//                       summarizes the active plan. Never writes: new tasks
//                       come back as a REVIEW_TASKS action the user confirms.
//   interventionAgent → rules only, no LLM: nudges from the user's own data
//                       (missed plan blocks, sessions stopped early, a close
//                       deadline with work left). Every number comes from data.
//   studyAgent        → placeholder until course materials (RAG) exist.
import Session from '../../models/Session.js';
import StudyTask from '../../models/StudyTask.js';
import StudyPlan from '../../models/StudyPlan.js';
import { runCoachTurn } from '../coach/coachService.js';
import { parseStudyRequest } from '../planner/ai.js';
import { getActivePlan, replanSuggested, blockEndsAt } from '../planner/planService.js';
import { resolveTimezone, userTodayStr, shiftDateStr, diffDays } from '../../utils/datetime.js';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (dateStr, today) => {
  if (dateStr === today) return 'today';
  if (dateStr === shiftDateStr(today, 1)) return 'tomorrow';
  const d = new Date(`${dateStr}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()}`;
};
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ─── Focus (coach) ───────────────────────────────────────────────────────────

export async function focusAgent({ user, message, log }) {
  const r = await runCoachTurn({ user, history: [], message, log });
  if (r.status !== 'ok') return { agent: 'focus', status: 'unavailable', reason: r.unavailableReason ?? 'service_unavailable' };
  return { agent: 'focus', status: 'ok', sections: r.sections, dataGaps: r.dataGaps };
}

// ─── Planner ─────────────────────────────────────────────────────────────────

const STATUS_RE = /\b(my plan|next (?:study )?session|what(?:'s| is) (?:next|planned)|today'?s plan|missed|planned for)\b/i;

/** Deterministic summary of the active plan (no LLM). */
export async function planStatus(user) {
  const tz = resolveTimezone(user);
  const today = userTodayStr(tz);
  const plan = await getActivePlan(user._id);
  if (!plan) {
    return { kind: 'plan_status', text: "You don't have a study plan yet. Tell me your exams or assignments and I'll draft one.", actions: [{ type: 'START_PLAN' }] };
  }
  const now = new Date();
  const titles = Object.fromEntries((await StudyTask.find({ userId: user._id, _id: { $in: plan.blocks.map(b => b.taskId) } }, { title: 1 }).lean())
    .map(t => [String(t._id), t.title]));
  const upcoming = plan.blocks
    .filter(b => b.status === 'PLANNED' && blockEndsAt(b, plan.timezone) > now)
    .sort((a, b) => (a.dateStr === b.dateStr ? a.startMinute - b.startMinute : a.dateStr < b.dateStr ? -1 : 1))
    .slice(0, 3);
  const missed = plan.blocks.filter(b => b.status === 'MISSED').length;

  const lines = upcoming.map(b => `${dayLabel(b.dateStr, today)} ${hhmm(b.startMinute)} – ${titles[String(b.taskId)] ?? 'Study'} (${b.durationMinutes} min)`);
  let text = upcoming.length ? `Your next sessions: ${lines.join('; ')}.` : 'There are no more sessions planned.';
  if (missed) text += ` ${missed} planned session${missed === 1 ? ' was' : 's were'} missed.`;
  const actions = [{ type: 'OPEN_PLAN' }];
  if (replanSuggested(plan)) actions.push({ type: 'REPLAN' });
  return { kind: 'plan_status', text, upcoming: upcoming.map(b => ({ id: String(b._id), dateStr: b.dateStr, startMinute: b.startMinute, durationMinutes: b.durationMinutes, taskTitle: titles[String(b.taskId)] ?? null })), actions };
}

export async function plannerAgent({ user, message, log }) {
  if (STATUS_RE.test(message)) return { agent: 'planner', status: 'ok', ...(await planStatus(user)) };

  const tz = resolveTimezone(user);
  const parsed = await parseStudyRequest({
    text: message, today: userTodayStr(tz), tz, categories: user.categories ?? [], userId: user._id, log,
  });
  if (parsed.source !== 'llm') {
    return { agent: 'planner', status: 'unavailable', reason: parsed.reason === 'user_daily_limit' ? 'daily_limit' : 'service_unavailable', actions: [{ type: 'OPEN_PLAN' }] };
  }
  if (parsed.tasks.length === 0) {
    // Nothing new to add — answer with the plan instead, plus any questions.
    return { agent: 'planner', status: 'ok', ...(await planStatus(user)), questions: parsed.questions };
  }
  return {
    agent: 'planner', status: 'ok', kind: 'review_tasks',
    text: `I found ${parsed.tasks.length} ${parsed.tasks.length === 1 ? 'task' : 'tasks'}. Check ${parsed.tasks.length === 1 ? 'it' : 'them'}, then I'll build your plan.`,
    tasks: parsed.tasks,
    questions: parsed.questions,
    actions: [{ type: 'REVIEW_TASKS', tasks: parsed.tasks }],
  };
}

// ─── Intervention (rules only) ───────────────────────────────────────────────

export const INTERVENTION_LOOKBACK_DAYS = 7;

/** Nudges from the user's own data. No LLM, no writes. */
export async function interventionAgent({ user }) {
  const tz = resolveTimezone(user);
  const today = userTodayStr(tz);
  const since = new Date(Date.now() - INTERVENTION_LOOKBACK_DAYS * 86_400_000);
  const [plan, ended, tasks] = await Promise.all([
    StudyPlan.findOne({ userId: user._id, status: 'ACTIVE' }),
    Session.find({ userId: user._id, status: { $in: ['COMPLETED', 'ABANDONED'] }, startedAt: { $gte: since } }, { status: 1 }).lean(),
    StudyTask.find({ userId: user._id, status: 'OPEN', deadline: { $gte: today, $lte: shiftDateStr(today, 2) } }).lean(),
  ]);
  const nudges = [];

  if (plan && replanSuggested(plan)) {
    const since2 = plan.approvedAt ?? plan.generatedAt;
    const n = plan.blocks.filter(b => b.status === 'MISSED' && blockEndsAt(b, plan.timezone) > since2).length;
    nudges.push({ code: 'MISSED_BLOCKS', text: `You missed ${n} planned session${n === 1 ? '' : 's'} since your plan was approved. Want an updated plan?`, action: { type: 'REPLAN' } });
  }

  const abandoned = ended.filter(s => s.status === 'ABANDONED').length;
  if (abandoned >= 3 && abandoned >= ended.length - abandoned) {
    nudges.push({ code: 'STOPPED_EARLY', text: `${abandoned} of your last ${ended.length} sessions were stopped early. Shorter sessions may be easier to finish.` });
  }

  for (const t of tasks.sort((a, b) => (a.deadline < b.deadline ? -1 : 1))) {
    const left = Math.max(0, t.estimatedMinutes - t.completedMinutes);
    if (left <= 0) continue;
    const days = diffDays(today, t.deadline);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    nudges.push({ code: 'DEADLINE_SOON', text: `${t.title} is due ${when} and still needs about ${left} minutes.`, action: { type: 'OPEN_PLAN' } });
    break;   // the closest one is enough
  }
  return { agent: 'intervention', status: 'ok', nudges };
}

// ─── Study (placeholder) ─────────────────────────────────────────────────────

export async function studyAgent() {
  return {
    agent: 'study', status: 'unavailable', reason: 'not_available_yet',
    notice: 'Help with course materials is coming soon. For now I can help with your focus and your study plan.',
  };
}

export const AGENT_FUNCTIONS = { focus: focusAgent, planner: plannerAgent, study: studyAgent };
