// AI assistant orchestrator: one entry point for every assistant message.
//
//   message → router (rules first, LLM only when ambiguous)
//           → selected agents IN PARALLEL (Promise.allSettled), each with a
//             timeout, plus the rule-based intervention agent
//           → merge + validate → one response
//
// Safety:
//   - Read-only. No agent writes: the planner returns new tasks as a
//     REVIEW_TASKS action the user must confirm in the app (human approval).
//   - Each agent is bounded by AGENT_TIMEOUT_MS; a slow or failing agent
//     becomes { status: 'unavailable' } and the others still answer.
//   - The LLM budget per message is bounded by the agents themselves (router
//     ≤ 1 call, coach ≤ 5 steps, planner parse ≤ 1 call + one corrective
//     retry) and by the per-user daily quota in llm/userQuota.js.
//   - The validator only lets known agents, known action types and the
//     documented fields through to the client.
import { routeMessage, AGENTS } from './router.js';
import { AGENT_FUNCTIONS, interventionAgent } from './agents.js';
import logger from '../../utils/logger.js';

export const AGENT_TIMEOUT_MS = 60_000;
export const MAX_MESSAGE_LEN = 1000;
export const ACTION_TYPES = Object.freeze(['REVIEW_TASKS', 'OPEN_PLAN', 'REPLAN', 'START_PLAN']);

const OFF_TOPIC_NOTICE = 'I can help with your focus sessions, your study plan and deadlines. Course materials help is coming soon.';

function withTimeout(promise, ms, agent) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${agent} agent timed out`), { code: 'AGENT_TIMEOUT' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ─── Validator ───────────────────────────────────────────────────────────────

const PART_FIELDS = {
  focus:   ['agent', 'status', 'reason', 'sections', 'dataGaps'],
  planner: ['agent', 'status', 'reason', 'kind', 'text', 'tasks', 'questions', 'upcoming'],
  study:   ['agent', 'status', 'reason', 'notice'],
};

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));

/** Keep only known agents, documented fields and allowed actions. Exported for tests. */
export function validateResponse({ route, parts, nudges, notice }) {
  const actions = [];
  const seen = new Set();
  const addAction = (a) => {
    if (!a || !ACTION_TYPES.includes(a.type)) return;
    const key = a.type === 'REVIEW_TASKS' ? 'REVIEW_TASKS' : a.type;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(a.type === 'REVIEW_TASKS' ? { type: a.type, tasks: a.tasks ?? [] } : { type: a.type });
  };

  const cleanParts = parts
    .filter(p => p && AGENTS.includes(p.agent))
    .map(p => { (p.actions ?? []).forEach(addAction); return pick(p, PART_FIELDS[p.agent]); });
  const cleanNudges = (nudges ?? []).map(n => { if (n.action) addAction(n.action); return pick(n, ['code', 'text']); });

  return {
    route: { agents: route.agents, source: route.source },
    parts: cleanParts,
    nudges: cleanNudges,
    actions,
    ...(notice ? { notice } : {}),
  };
}

// ─── Turn ────────────────────────────────────────────────────────────────────

/**
 * Run one assistant message.
 * @param user     AUTHENTICATED user doc (req.user) — the only identity source
 * @param message  validated user text
 * @param only     optional agent list that bypasses the router (benchmark baseline)
 */
export async function runAssistantTurn({ user, message, log = logger, only, timeoutMs = AGENT_TIMEOUT_MS }) {
  const started = Date.now();
  const route = only
    ? { agents: only.filter(a => AGENTS.includes(a)), offTopic: false, source: 'forced' }
    : await routeMessage(message, { userId: user._id, log });

  const jobs = route.agents.map(agent => withTimeout(AGENT_FUNCTIONS[agent]({ user, message, log }), timeoutMs, agent)
    .catch((err) => {
      log.warn({ agent, err: err.message, code: err.code }, '[assistant] agent failed');
      return { agent, status: 'unavailable', reason: err.code === 'AGENT_TIMEOUT' ? 'timeout' : 'error' };
    }));
  // Intervention runs alongside every turn: cheap (database only) and useful.
  const nudgeJob = withTimeout(interventionAgent({ user }), timeoutMs, 'intervention')
    .catch((err) => { log.warn({ err: err.message }, '[assistant] intervention failed'); return { nudges: [] }; });

  const [parts, intervention] = await Promise.all([Promise.all(jobs), nudgeJob]);
  // Stable order regardless of which agent finished first.
  parts.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent));

  const response = validateResponse({
    route, parts, nudges: intervention.nudges,
    notice: route.agents.length === 0 ? OFF_TOPIC_NOTICE : null,
  });
  const latencyMs = Date.now() - started;
  log.info({ assistant: { agents: route.agents, source: route.source, statuses: parts.map(p => `${p.agent}:${p.status}`), latencyMs } }, '[assistant] turn');
  return { ...response, latencyMs };
}
