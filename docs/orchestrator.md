# AI assistant orchestrator

One endpoint for the app's assistant chat. A message goes to the right agents: the Focus Coach, the Study Planner, or both at once. The answers come back merged.

Code: `backend/services/orchestrator/` (`router.js`, `agents.js`, `orchestrator.js`) and `backend/routes/assistant.js`.

```
message ──► Router ──► agents in parallel ──► merge + validate ──► one response
            rules first      focus (coach)          known agents, fields
            LLM if unclear   planner                and actions only
                             study (coming soon)
            + intervention (rules, every message)
```

## Router (`router.js`)

1. **Keyword rules** (free). When exactly one area matches, it decides, and no model is called.
   - **focus:** focus, distraction, score, streak, sessions, best hour…
   - **planner:** plan, schedule, exam, quiz, assignment, deadline, next session, missed…
   - **study:** explain, summarize, lecture, notes, flashcards, formula…
2. **LLM router** (`assistant_route`, fast tier: Gemini 3.5 Flash-Lite → GitHub gpt-4.1-mini). Used only when several areas or none match. It returns `{focus, planner, study, offTopic}`.
3. **Fallback.** If the model can't answer, every keyword-matched area runs. Routing never fails.

## Agents (`agents.js`)

Plain functions that each return `{ agent, status: 'ok' | 'unavailable', … }`.

| Agent | Uses the LLM? | What it does |
|---|---|---|
| **focus** | yes (coach, ≤ 5 steps) | Runs one AI Focus Coach turn (`runCoachTurn`), with grounded numbers and read-only tools. Returns `sections` and `dataGaps`. |
| **planner** | parse only (≤ 1 call + retry) | *"What's my next session?"* → a deterministic summary of the active plan (no LLM). New deadlines in the message → the AI parse → `kind: 'review_tasks'` with the draft tasks. **Never saves**: the app must show the review screen. |
| **intervention** | no | Rules on the user's data. Nudges for missed plan blocks (→ re-plan), many sessions stopped early, and the closest deadline with work left. Runs on every message. Every number comes from the database. |
| **study** | — | Placeholder until course materials (RAG) exist: `status: 'unavailable', reason: 'not_available_yet'`. |

## Orchestrator (`orchestrator.js`)

- The selected agents and the intervention agent run **in parallel** (`Promise.all`).
- **Timeout per agent:** 60 s. A slow or failing agent returns `{status: 'unavailable', reason: 'timeout' | 'error'}`, and the others still answer.
- **Budget per message:**
  - router ≤ 1 LLM call
  - coach ≤ 5
  - parse ≤ 2

  All of these count against the per-user `AI_DAILY_LIMIT`. The endpoint is also limited to 10 messages a minute per user.
- **Human approval:** no agent writes anything. Changes come back as actions the app confirms.
- **Validator:** only known agents, documented fields and allowed action types reach the client. Actions are de-duplicated.

## API

`POST /api/ai/assistant` with `{ "message": "…" }` (1–1000 characters, Bearer token).

```jsonc
{
  "route":  { "agents": ["focus", "planner"], "source": "rules" | "llm" | "fallback" },
  "parts": [
    { "agent": "focus", "status": "ok",
      "sections": [{ "kind": "measured_data" | "ai_suggestion", "text": "…" }], "dataGaps": [] },
    { "agent": "planner", "status": "ok", "kind": "review_tasks",
      "text": "I found 2 tasks…", "tasks": [/* DraftTask, see planner-frontend.md */], "questions": [] },
    // or { "agent": "planner", "kind": "plan_status", "text": "Your next sessions: …", "upcoming": [ … ] }
    // or { "agent": "study", "status": "unavailable", "reason": "not_available_yet", "notice": "…" }
  ],
  "nudges":  [{ "code": "MISSED_BLOCKS" | "STOPPED_EARLY" | "DEADLINE_SOON", "text": "…" }],
  "actions": [{ "type": "REVIEW_TASKS", "tasks": [ … ] }, { "type": "OPEN_PLAN" }, { "type": "REPLAN" }, { "type": "START_PLAN" }],
  "notice":  "…",          // only when the message is off-topic
  "latencyMs": 1234
}
```

### What the app does with it

- **Show `parts` in order** as one assistant reply:
  - focus `sections`, labelled *measured* vs *suggestion* the same way as the coach
  - the planner `text`
  - the study `notice`
- **An unavailable part** shows a short "couldn't answer this part" note. Use `reason: 'daily_limit'` for the AI limit message.
- **Show `nudges`** as small cards under the reply.
- **Turn `actions` into buttons:**
  - `REVIEW_TASKS` → open the planner's Review screen with `tasks`, then the normal `POST /planner/tasks` → `/planner/preview` → approve flow
  - `OPEN_PLAN` → the Study Planner screen
  - `REPLAN` → `POST /planner/replan`
  - `START_PLAN` → the planner input screen

The endpoint is stateless: each message is answered on its own. Coach conversations with history stay at `/api/ai/coach/conversations`.

## Benchmark (`npm run ai:eval:assistant`)

`scripts/orchestrator-eval.mjs` routes 30 labeled messages (focus, planner, study, mixed, off-topic) and compares three setups:

| Setup | What decides |
|---|---|
| Single agent | Everything goes to the coach (no orchestrator) |
| LLM-only router | The model routes every message |
| Hybrid (ours) | Keyword rules first, the model only for unclear messages |

Metrics:
- **Exact accuracy:** the right set of agents.
- **Coverage:** every needed agent ran.
- **Over-routing:** extra agents ran, which is wasted cost.
- **LLM calls** and **average latency**.

`--offline` skips the model, so it's free.

**Live results** (2026-11-24, 30 messages, Gemini 3.5 Flash-Lite):

| Setup | Exact | Coverage | Over-routed | LLM calls | Model call fell back |
|---|---|---|---|---|---|
| Single agent (coach only) | 27% | 47% | 19 | 0 | — |
| LLM-only router | 93% | 97% | 1 | 30 | 2 |
| **Hybrid router (ours)** | **97%** | **97%** | **0** | **13** | 1 |

- The hybrid router was the most accurate while making 57% fewer model calls than the LLM-only router, and it never ran an unneeded agent.
- Its one miss was "I feel tired today": expected focus, routed to none.
- **Fell back** counts model calls that failed (provider busy or free-tier limit) and used the keyword guess instead. Those messages are still scored.
- **Latency isn't reported as model speed.** The run went through the local 10-requests-per-minute limiter, so the averages include queueing (hybrid 5.4 s, LLM-only 8.1 s per message).

Offline (rules only, no model): 90% exact, 97% coverage, 0 calls.

## Planned next: memory and cache

1. **Saved conversations.** Store assistant chats so the user can go back to earlier answers. Today each message is answered on its own.
2. **User memory.** Remember the user's details (subjects, goals, preferences, exam dates) and give the agents a short summary, so the user doesn't repeat them every message.
3. **Answer cache.** Reuse the answer to a repeated or very similar question instead of calling the model again, to save tokens. The cache must be cleared when the user's data changes (a new session, a plan change), because coach answers depend on live data.
