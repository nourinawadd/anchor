// Benchmark for the assistant orchestrator's routing (docs/orchestrator.md).
//
// Compares three ways to decide which agents answer a message, on a labeled
// set of student messages:
//   1. Single agent   — everything goes to the focus coach (no orchestrator).
//   2. LLM-only router — the router model decides every message.
//   3. Hybrid (ours)  — keyword rules decide clear messages; the model only
//                       sees ambiguous ones.
// Metrics: exact routing accuracy, coverage (every needed agent ran),
// over-routing (extra agents ran = wasted cost), LLM calls and latency.
//
// Run from backend/:
//   npm run ai:eval:assistant              (uses the real model: ~45 calls)
//   npm run ai:eval:assistant -- --offline (rules + single-agent only, free)
import { routeByRules, routeMessage, AGENTS } from '../services/orchestrator/router.js';

const offline = process.argv.includes('--offline');

// expected = agents that should answer. [] = off-topic.
const CASES = [
  ['Why was my focus low this week?', ['focus']],
  ['When do I focus best?', ['focus']],
  ['How many sessions did I finish yesterday?', ['focus']],
  ['Am I getting distracted more than last week?', ['focus']],
  ['What is my current streak?', ['focus']],
  ['Do I concentrate better in the morning or evening?', ['focus']],
  ['Why do I keep stopping sessions early?', ['focus']],
  ['Physics exam on Thursday, chapter 4 is hard', ['planner']],
  ['I have a math assignment due Friday night', ['planner']],
  ['Add a chemistry quiz next Monday at 10', ['planner']],
  ["What's my next session?", ['planner']],
  ['Make me a study plan for my finals', ['planner']],
  ['I missed yesterday, can you reschedule?', ['planner']],
  ['Midterm in 2 weeks for biology, about 6 hours of work', ['planner']],
  ['Explain integration by parts', ['study']],
  ['Summarize my lecture notes on recursion', ['study']],
  ['What is the difference between mitosis and meiosis?', ['study']],
  ['Make flashcards from my history notes', ['study']],
  ['Teach me the chain rule', ['study']],
  ['Why was I distracted this week, and plan my exam week', ['focus', 'planner']],
  ['My focus has been bad, can you schedule shorter sessions before my quiz?', ['focus', 'planner']],
  ['When am I most productive? Put my hardest exam prep then', ['focus', 'planner']],
  ['Explain recursion and plan time to study it before Thursday', ['planner', 'study']],
  ['hello', []],
  ['tell me a joke', []],
  ["what's the weather like?", []],
  ['thanks!', []],
  ['who are you?', []],
  ['I feel tired today', ['focus']],
  ['Can you help me?', []],
];

const key = (a) => [...a].sort().join('+') || '(none)';
function score(name, results) {
  const n = results.length;
  const exact = results.filter(r => key(r.got) === key(r.expected)).length;
  const covered = results.filter(r => r.expected.every(a => r.got.includes(a))).length;
  const extra = results.filter(r => r.got.some(a => !r.expected.includes(a))).length;
  const calls = results.reduce((a, r) => a + (r.llmCalls ?? 0), 0);
  const ms = results.reduce((a, r) => a + (r.ms ?? 0), 0);
  // Model calls that failed and fell back to keywords: if >0 the LLM rows
  // don't fully reflect the model.
  const fellBack = results.filter(r => r.note === 'fallback').length;
  return { name, exact: `${exact}/${n} (${Math.round(100 * exact / n)}%)`, coverage: `${covered}/${n} (${Math.round(100 * covered / n)}%)`,
    overRouted: extra, llmCalls: calls, fellBack, avgMs: Math.round(ms / n) };
}

const rows = [];

// 1. Single agent: always the coach.
rows.push(score('Single agent (coach only)', CASES.map(([, expected]) => ({ expected, got: ['focus'], llmCalls: 0, ms: 0 }))));

// 2/3 need the model for ambiguous messages.
const hybrid = [];
const llmOnly = [];
for (const [msg, expected] of CASES) {
  const rules = routeByRules(msg);
  if (offline) {
    hybrid.push({ msg, expected, got: rules.decided ? rules.agents : rules.agents, llmCalls: 0, ms: 0, note: rules.decided ? '' : 'undecided→keyword guess' });
    continue;
  }
  let t = Date.now();
  const h = await routeMessage(msg, {});
  hybrid.push({ msg, expected, got: h.agents, llmCalls: rules.decided ? 0 : 1, ms: Date.now() - t, note: h.source });

  // LLM-only: the model decides every message (keyword rules bypassed).
  t = Date.now();
  const forced = await routeMessage(msg, { forceModel: true });
  llmOnly.push({ msg, expected, got: forced.agents, llmCalls: 1, ms: Date.now() - t, note: forced.source });
}
if (!offline) rows.push(score('LLM-only router', llmOnly));
rows.push(score(offline ? 'Hybrid (rules only, offline)' : 'Hybrid router (ours)', hybrid));

console.log('\nRouting benchmark —', CASES.length, 'labeled messages\n');
console.table(rows);
console.log('\nMisrouted by the hybrid router:');
for (const r of hybrid.filter(x => key(x.got) !== key(x.expected))) {
  console.log(`  "${r.msg}"  expected ${key(r.expected)}, got ${key(r.got)}${r.note ? `  [${r.note}]` : ''}`);
}
console.log(`\nAgents: ${AGENTS.join(', ')}. Coverage = every needed agent ran. Over-routed = an agent ran that wasn't needed (extra cost).`);
