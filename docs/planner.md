# Study Planner (backend)

The planner turns a student's deadlines (exams, quizzes, assignments, study goals) into a schedule of focus-session blocks. It places hard work in the student's best focus hours and keeps every block before its deadline.

This page covers the backend: `backend/services/planner/`, `backend/routes/planner.js`, `backend/models/StudyTask.js` and `backend/models/StudyPlan.js`. For what the app should show, see [planner-frontend.md](planner-frontend.md).

## Who does what

| Step | Done by |
|---|---|
| Read "Physics exam Thursday, ch. 4 is hard" into tasks | **LLM** (`planner_parse`, fast tier) |
| Turn "Thursday" into a date, and check it | **Code** (zod plus a server check, with one corrective retry) |
| Choose days and times for study blocks | **Code**: the scheduler (no AI) |
| Explain the plan in 2–3 sentences | **LLM** (`planner_explain`, fast tier), with numbers grounded in the plan |
| Save a plan | **Code**, only after the user approves a draft |

The model never picks dates or times for blocks, so it can't produce an impossible schedule.

Both LLM tasks use the existing chain (Gemini 3.5 Flash-Lite, then GitHub gpt-4.1-mini). The per-provider rate limits, the per-user `AI_DAILY_LIMIT` and the corrective retry all apply. There are no new environment variables.

## Data

**`StudyTask`**: one deadline.
- `categoryId`: the subject, one of `User.categories`.
- `title`, `kind` (`EXAM | QUIZ | ASSIGNMENT | STUDY`).
- `deadline` (a local `YYYY-MM-DD` date) and an optional `deadlineTime` (`HH:MM`, display only).
- `difficulty` (1–3), `estimatedMinutes`, and `completedMinutes`, which grows as sessions started from its blocks end.
- `status` (`OPEN | DONE | CANCELLED`). A task becomes `DONE` automatically when `completedMinutes ≥ estimatedMinutes`.

**`StudyPlan`**: a set of blocks.
- `status`:
  - `DRAFT`: a preview, at most one per user; a new preview replaces it.
  - `ACTIVE`: the approved plan, at most one per user.
  - `ARCHIVED`: replaced by a newer approved plan.
- `explanation`, plus `explanationSource` (`llm` or `fallback`).
- `warnings`, and `timezone` (the user's zone when the plan was built).
- **Block** fields:
  - `taskId`, `categoryId`
  - `dateStr`, `startMinute` (minutes from local midnight), `durationMinutes`
  - `kind` (`STUDY | REVIEW`)
  - `status`: `PLANNED`, `IN_PROGRESS`, `DONE`, `MISSED` or `SKIPPED`
  - `sessionId`
  - `locked`: true when the user moved the block

**`User.settings.planner`**: when the student can study.
- `windows`: a list of `{weekday 0=Sun, start, end}` in minutes from midnight. The defaults are 16:00–22:00, and 10:00–22:00 on Friday and Saturday.
- `maxDailyMinutes` (240), `sessionLength` (50), `breakBetween` (10), `noStudyAfter` (1380 = 23:00).

**`Session.planBlockId`**: set when a focus session is started from a block.

## The scheduler (`services/planner/scheduler.js`)

A pure function: the same input always gives the same output. It's tested in `test/plannerScheduler.test.js`.

1. **Free time.** For every day from today to the latest deadline (at most 60 days): take the study windows for that weekday, cut at `noStudyAfter`, and remove time already past today. Then remove kept blocks, plus `breakBetween` padding.
2. **Order.** Earliest deadline first, then hardest first.
3. **Review.** Exams and quizzes get a 30-minute `REVIEW` block the day before, placed first. A re-plan skips this when a kept review already exists.
4. **Blocks.**
   - The remaining minutes are split into blocks: `sessionLength` for hard tasks, 90% of it for medium, 60% for easy, never under 15.
   - Each block goes to the highest-scoring free 15-minute-aligned slot before the deadline:
     ```
     score = 3 × hourScore × (0.5 + difficulty/3)   best focus hours, more so for hard work
           + 1.5 × urgency                          earlier days score higher
           − 1.5 if this task already has a block that day, −3 more for a third
           − 0.5 after 21:00
     ```
   - A slot is skipped if it would push the day past `maxDailyMinutes`.
5. **Warnings.**
   - `NOT_ENOUGH_TIME` (with the minutes that didn't fit) when space runs out. The plan is partial; the scheduler never fails.
   - `DEADLINE_TOO_SOON` for a deadline of today.

**Hour scores** come from the last 30 days of completed sessions: the average focus score per local start hour, blended with a default curve (2 pseudo-sessions per hour). Below 5 sessions, the default curve is used on its own.

## Lifecycle

```
tasks ──► POST /preview ──► DRAFT ──► POST /plans/:id/approve ──► ACTIVE
                               ▲                                     │
                               └──── POST /replan ◄── missed blocks ─┘
```

- **Preview and re-plan** keep every block the user already acted on, with the same ids, so session links survive:
  - done, in progress, missed, skipped
  - moved (locked) blocks
  
  Only future unlocked `PLANNED` blocks are placed again. A task's remaining minutes subtract the time in kept future blocks.
- **Approve.**
  - Kept blocks take their latest state (status, session, position) from the current `ACTIVE` plan, in case something happened between the preview and the approval.
  - Blocks the user acted on after the preview (started, finished, skipped, moved) are carried into the new plan.
  - If one of them now overlaps a newly placed block, the user's block wins: the new one is dropped and a `PLAN_CHANGED` warning tells the app to offer **Update plan**.
  - The old plan becomes `ARCHIVED` with `supersededBy` pointing to the new one. If the server stops between archiving and activating, the next `GET /plan` finishes the approval.
- **One draft, one active.** A unique index allows at most one `DRAFT` and one `ACTIVE` plan per user. Two previews racing leave the later draft. Two approvals racing: only one wins, and the other returns 404.
- **Missed.** On every read (`GET /plan`, `/calendar`), `PLANNED` blocks whose end time has passed become `MISSED`. `replanSuggested` is true when a block was missed after the plan was approved, so the app can offer a re-plan.
- **Sessions.**
  1. `POST /api/sessions` with `planBlockId` checks that the block belongs to the user's active plan and is `PLANNED` or `MISSED`. Otherwise it returns 400 and no session is created.
  2. It then marks the block `IN_PROGRESS`.
  3. When the session ends: `COMPLETED` makes the block `DONE`. `ABANDONED` puts it back to `PLANNED`, or `MISSED` if its time has passed. In both cases the focus minutes are added to the task.
- **Cleanup.** Deleting a task removes its not-done blocks. Deleting a category removes its tasks and their open blocks. Deleting the account removes all tasks and plans.

## Endpoints (`/api/planner`, Bearer token)

Every lookup is scoped to the user. Another user's task, plan or block returns 404, the same as a missing one. Unknown body fields return 400. `parse`, `preview` and `replan` call the LLM and are limited to 10 per minute per user.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/settings` | — | planner settings |
| PUT | `/settings` | any of `windows`, `maxDailyMinutes`, `sessionLength`, `breakBetween`, `noStudyAfter` | settings |
| POST | `/parse` | `{ text }` (≤ 2000 chars) | `{ tasks, questions, source, unavailableReason }`. Nothing is saved. |
| GET | `/tasks` | `?status=OPEN\|DONE\|CANCELLED\|ALL` (default `OPEN`) | `{ tasks }` |
| POST | `/tasks` | `{ tasks: [ {title, categoryId, deadline, estimatedMinutes, kind?, deadlineTime?, difficulty?, source?} ] }` (1–30) | `{ tasks }` (201). Max 60 open (409). |
| PATCH | `/tasks/:id` | any task field, or `status` | `{ task }` |
| DELETE | `/tasks/:id` | — | `{ deleted: true }` |
| POST | `/preview` | — | `{ plan }` (DRAFT, 201) |
| GET | `/draft` | — | `{ plan }` or `{ plan: null }` |
| DELETE | `/draft` | — | `{ deleted }` |
| POST | `/plans/:id/approve` | — | `{ plan }` (ACTIVE) |
| GET | `/plan` | — | `{ plan }` (ACTIVE, with `replanSuggested`), or `{ plan: null }` |
| POST | `/replan` | — | `{ plan }` (DRAFT, reason `REPLAN`, 201) |
| PATCH | `/blocks/:blockId` | `{ action: 'skip' }` or `{ action: 'move', dateStr, startMinute }` | `{ plan }` |
| GET | `/calendar` | `?from=YYYY-MM-DD&to=YYYY-MM-DD` (≤ 92 days) | `{ from, to, today, sessions, deadlines, blocks, replanSuggested }` |

**Move rules.** The block must be `PLANNED` or `MISSED`. It can't be moved into the past, onto or after its deadline, or onto another block. It can't cross midnight. A moved block is `locked`, so a re-plan keeps it in place.

## AI details

**`planner_parse`**
- **Prompt:** today's date and weekday, the timezone, and the student's course names. The student's text is fenced and marked as data.
- **The server rejects:**
  - a non-real date
  - a deadline before today or more than a year away
  - a bad `HH:MM`
  - a course name that isn't one of the user's categories

  The model gets one corrective retry. After that the next provider is tried, and then an empty result. In the empty case the app shows the manual form; `unavailableReason` says whether the daily limit was the cause.
- **Estimates:** when the student gives no estimate, the code fills in a default by kind and difficulty.

| Kind | Easy | Medium | Hard |
|---|---|---|---|
| Exam | 4 h | 6 h | 10 h |
| Quiz | 1.5 h | 2 h | 3 h |
| Assignment | 2 h | 3 h | 5 h |
| Study | 1 h | 1.5 h | 2 h |

**`planner_explain`**
- **Input:** a summary of the built plan (totals, per-task blocks and minutes, most-used start times, warnings).
- **Grounding:** every number in the explanation must appear in that summary, using the coach's grounding helper. Otherwise the reply gets a corrective retry, then falls back to a deterministic rule-based sentence.

## Known limits and next steps

- **Categories are capped at 3** (`POST /api/user/categories`). Students with more courses need a higher limit, or a separate courses model, before the planner is used for a full semester.
- **No push notification yet** for missed blocks. The app learns about them on its next `GET /plan` (`replanSuggested`). A follow-up can add a daily check to `jobs/notificationCron.js`.
- **Phone calendar events aren't sent to the scheduler.** It only sees study windows and kept blocks. Sending busy times from `expo-calendar` would need a `busy` field on `/preview`.
- **Exam timetable photo upload** isn't implemented. Parsing is text only.
