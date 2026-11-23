# Study Planner: frontend handoff

The backend is done (see [planner.md](planner.md)). This file is the map for building the app side: **which screens go where, what each shows, what the user can do, and which endpoint each action calls.**

It doesn't set any design. Use the app's existing components (`Card`, `SectionLabel`, `PillBadge`, `WheelPicker`, `CircularProgress`) and the Dashboard / AI Insights look. The clickable mockup the team reviewed shows the intended flow, not final visuals.

All calls go through `apiFetch` in `frontend/api/client.ts`, with paths relative to `/api`.

---

## 1. Where the planner lives in the app

| Change | File | What to add |
|---|---|---|
| New screen names | `App.tsx` → `ScreenName` | `'Planner' \| 'PlanInput' \| 'PlanReview' \| 'PlanPreview' \| 'StudyAvailability'` |
| Render the screens | `App.tsx` (screen switch, ~line 420) | one `{current === 'Planner' && <PlannerScreen nav={nav} />}` line per screen |
| Drawer entry | `components/Drawer.tsx` → `NAV_ITEMS` | `{ label: 'Study Planner', screen: 'Planner' }` |
| Typed API calls | **new** `frontend/api/planner.ts` | one function per endpoint below (types in §6) |
| Calendar (history + upcoming) | `screens/HistoryScreen.tsx` | switch its data to `GET /planner/calendar` (§4) |
| "Up next" card | `screens/AIInsightsScreen.tsx` (and/or `DashboardScreen.tsx`) | next deadline + next planned block (§5) |
| Start a block | `screens/CreateSessionScreen.tsx` | accept prefill params, send `planBlockId` (§3.6) |

---

## 2. The flow

```
 Study Planner (list) ──[+ Plan my study]──► Plan input ──► Review tasks ──► Preview ──[Approve]──► Study Planner
        │                                     (text / form)   (edit cards)    (draft plan)
        ├──[▶ Start on a block]──► Create Session (prefilled) ──► Active Session ──► block DONE
        └──[replanSuggested banner]──► Preview (re-plan draft) ──[Approve]
 First time only: Study availability (windows, daily max, session length)
```

---

## 3. Screens

### 3.1 `PlannerScreen.tsx`: the main list (new)

**Shows**
- The ACTIVE plan's blocks grouped by day: date header, then each block's start–end time, task title, subject, and kind (`STUDY` / `REVIEW`).
- A status per block:
  - `PLANNED` → **Start** button
  - `IN_PROGRESS` → "In progress"
  - `DONE` → done mark
  - `MISSED` → "Missed"
  - `SKIPPED` → "Skipped"
- Plan `warnings` at the top (each has a ready-to-show `message`).
- The plan `explanation`. When `explanationSource === 'fallback'`, label it "Based on your data", like AI Insights.
- A **banner** when `replanSuggested` is true: *"You missed some sessions. See an updated plan?"*

**Actions**
| Action | Call |
|---|---|
| Open screen | `GET /planner/plan` → `{ plan \| null }` |
| No plan yet | show an empty state with **Plan my study** → `PlanInput` |
| **Start** a block | navigate to `CreateSession` with prefill (§3.6) |
| Long-press → **Skip** | `PATCH /planner/blocks/:id` `{ action: 'skip' }` → updated `{ plan }` |
| Long-press → **Move** | pick a day and time → `PATCH /planner/blocks/:id` `{ action: 'move', dateStr, startMinute }`. On 400, show `message` (past, after deadline, overlap). |
| Banner → **See updated plan** | `POST /planner/replan` → draft → `PlanPreview` |
| **+ Plan my study** | `PlanInput` |
| **Tasks** button (optional) | `GET /planner/tasks` list with edit/delete |

### 3.2 `PlanInputScreen.tsx`: describe what to study (new)

**Shows**
- A multiline text box: *"What do you need to study? e.g. Physics exam Thursday, chapters 3–4, chapter 4 is hard."*
- **Continue**, plus a link: **Add manually instead**.

**Actions**
| Action | Call |
|---|---|
| Continue | `POST /planner/parse` `{ text }` → `{ tasks, questions, source, unavailableReason }`. **Nothing is saved yet.** |
| Result has tasks | → `PlanReview` with those draft tasks and `questions` |
| `tasks` is empty | → `PlanReview` with an empty form. If `unavailableReason === 'daily_limit'`, say "AI limit reached for today, add your tasks below"; otherwise "Couldn't read that, add your tasks below". |
| Add manually | → `PlanReview` with one empty card |

### 3.3 `PlanReviewScreen.tsx`: check and edit the tasks (new)

**Shows:** one editable card per draft task.
- **Title.**
- **Subject:** a picker from `GET /user/categories`. If the task's `categoryId` is `null` (the AI couldn't match the course), make it **required** and show the AI's `courseName` as a hint.
- **Kind:** Exam / Quiz / Assignment / Study.
- **Deadline:** a date picker with a month view, no past dates, and an optional time.
- **Difficulty:** Easy / Medium / Hard (`1 / 2 / 3`).
- **Study time:** `estimatedMinutes`, e.g. via `WheelPicker` in 15-minute steps. When `estimateSource === 'default'`, show *"Suggested, change if needed"*.
- The AI's `questions` above the cards, as hints.
- **+ Add task**, **Remove** on each card.

**Actions**
| Action | Call |
|---|---|
| **Make my plan** | `POST /planner/tasks` `{ tasks: [...] }` (send `source: 'AI'` for parsed tasks, `'MANUAL'` for hand-added) → then `POST /planner/preview` → `PlanPreview` |
| Validation error (400) | show `message` on the matching card. Messages name the field, e.g. `tasks[1].deadline must not be in the past`. |
| 409 (too many open tasks) | show `message` |

### 3.4 `PlanPreviewScreen.tsx`: approve the draft (new)

**Shows**
- `explanation` (and "Based on your data" when `explanationSource === 'fallback'`).
- `totals`: number of blocks and total minutes. Show it as hours.
- `warnings`, prominently: these say what didn't fit.
- Blocks grouped by day, the same row layout as §3.1 but **without Start buttons**: it's only a draft.

**Actions**
| Action | Call |
|---|---|
| **Approve** | `POST /planner/plans/:id/approve` → `PlannerScreen`. Optionally offer "Add to phone calendar" (`utils/calendar.ts`). |
| **Edit tasks** | back to `PlanReview` (or a task list), then `POST /planner/preview` again |
| **Cancel** | `DELETE /planner/draft` |
| Reopen later | `GET /planner/draft` returns the pending draft, if any |

### 3.5 `StudyAvailabilityScreen.tsx`: when can you study (new; also linked from Settings)

**Shows**
- Per weekday, one or more time ranges (start and end).
- Max hours per day, preferred session length, break between sessions, and "no study after".

**Actions**
| Action | Call |
|---|---|
| Open | `GET /planner/settings` |
| Save | `PUT /planner/settings` with only the changed fields. Times are **minutes from midnight** (16:00 = 960). `weekday` 0 = Sunday. |

Show this once before the first plan, e.g. from `PlanInput` when the user has never saved it, or as a step after the onboarding calendar screen. Defaults: 16:00–22:00 on weekdays, 10:00–22:00 on Friday and Saturday.

### 3.6 Starting a block: `CreateSessionScreen.tsx` (change)

From a block's **Start** button, navigate with prefill:

```ts
nav.navigate('CreateSession', {
  categoryId:  block.categoryId,
  customName:  block.taskTitle ?? 'Study',
  minutes:     String(block.durationMinutes),
  planBlockId: block.id,
});
```

When `planBlockId` is present, include it in the existing `POST /sessions` body: `{ ...currentBody, planBlockId }`. No other change is needed. Ending the session (`PATCH /sessions/:id/end`) updates the block and the task's progress on the server automatically.

If `POST /sessions` returns 400 *"This plan block is already …"*, the block was already started or done. Go back and refresh the planner.

---

## 4. Calendar (History + upcoming), `HistoryScreen.tsx` (change)

One request feeds the whole screen:

`GET /planner/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` (≤ 92 days) → `{ today, sessions, deadlines, blocks, replanSuggested }`

| Day | Show |
|---|---|
| Past days | `sessions` (the same records History shows now: title, time, score, or Abandoned) |
| Today | today's `sessions` + `blocks` + `deadlines` |
| Future days | `deadlines` (title, kind, `deadlineTime`) and `blocks` with **Start** |

- **Markers in the week or month strip:** sessions done, something due, block planned.
- **List order:** today and the days after it first, then past days, newest first.
- **"+":** open the same add-task form as `PlanReview` (single card) → `POST /planner/tasks` → then offer **Update plan** (`POST /planner/preview`).

---

## 5. "Up next" card (AI Insights / Dashboard)

From `GET /planner/calendar?from=today&to=today+14`:
- **Next deadline:** the first item in `deadlines` with a deadline today or later. Show "due in N days".
- **Next block:** the first item in `blocks` with status `PLANNED` and a date today or later, with a **Start** button (§3.6).
- **Open calendar** → `History`.

If there's nothing, show **Plan my study** → `PlanInput`.

---

## 6. Types for `frontend/api/planner.ts`

```ts
export type TaskKind = 'EXAM' | 'QUIZ' | 'ASSIGNMENT' | 'STUDY';
export type BlockStatus = 'PLANNED' | 'IN_PROGRESS' | 'DONE' | 'MISSED' | 'SKIPPED';

export type StudyTask = {
  id: string; categoryId: string; title: string; kind: TaskKind;
  deadline: string;            // YYYY-MM-DD (user's local day)
  deadlineTime: string | null; // "HH:MM"
  difficulty: 1 | 2 | 3;
  estimatedMinutes: number; completedMinutes: number; remainingMinutes: number;
  status: 'OPEN' | 'DONE' | 'CANCELLED'; source: 'AI' | 'MANUAL';
};

export type DraftTask = Omit<StudyTask, 'id' | 'completedMinutes' | 'remainingMinutes' | 'status' | 'source' | 'categoryId'> & {
  categoryId: string | null;   // null → user must pick a subject
  courseName: string;          // what the AI read (hint)
  estimateSource: 'user' | 'default';
};

export type PlanBlock = {
  id: string; taskId: string; taskTitle: string | null; categoryId: string;
  dateStr: string; startMinute: number; startTime: string; endTime: string;
  durationMinutes: number; kind: 'STUDY' | 'REVIEW'; status: BlockStatus;
  sessionId: string | null; locked: boolean;
};

export type PlanWarning = {
  code: 'NOT_ENOUGH_TIME' | 'DEADLINE_TOO_SOON' | 'PLAN_CHANGED';   // PLAN_CHANGED → offer "Update plan"
  taskId: string | null; minutes: number | null; message: string;
};

export type StudyPlan = {
  id: string; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; reason: 'PREVIEW' | 'REPLAN';
  timezone: string; generatedAt: string; approvedAt: string | null;
  explanation: string; explanationSource: 'llm' | 'fallback';
  warnings: PlanWarning[];
  totals: { blocks: number; minutes: number };
  blocks: PlanBlock[];
  replanSuggested?: boolean;   // on GET /plan and after edits
};

export type PlannerSettings = {
  windows: { weekday: number; start: number; end: number }[];  // minutes from midnight, 0 = Sunday
  maxDailyMinutes: number; sessionLength: number; breakBetween: number; noStudyAfter: number;
};

export type ParseResult = {
  tasks: DraftTask[]; questions: string[];
  source: 'llm' | 'fallback'; unavailableReason: 'daily_limit' | 'service_unavailable' | null;
};

export type CalendarFeed = {
  from: string; to: string; today: string;
  sessions: SessionRecord[];   // same shape as GET /sessions
  deadlines: StudyTask[];
  blocks: PlanBlock[];
  replanSuggested: boolean;
};
```

Suggested functions:
- `getPlannerSettings`, `savePlannerSettings`
- `parseStudyText`
- `listTasks`, `createTasks`, `updateTask`, `deleteTask`
- `previewPlan`, `getDraft`, `discardDraft`, `approvePlan`, `getActivePlan`, `replan`
- `skipBlock`, `moveBlock`
- `getCalendar`

---

## 7. States every planner screen should handle

| State | When | Show |
|---|---|---|
| Loading | any request | spinner or skeleton |
| No plan | `GET /plan` → `plan: null` | empty state + **Plan my study** |
| AI fallback | `explanationSource: 'fallback'`, or parse `source: 'fallback'` | "Based on your data" / the manual form |
| Daily AI limit | parse `unavailableReason: 'daily_limit'` | "AI limit reached for today", with the manual form still working |
| Partial plan | `warnings` not empty | warning list above the blocks |
| Too many requests | HTTP 429 | "Slow down, try again in a minute" |
| Validation | HTTP 400 | the server `message` (always human-readable) |
| Offline / 5xx | network error | retry button. Keep what the user typed. |

---

## 8. Not in scope yet

- **Push notifications for missed blocks** (backend follow-up). For now, check `replanSuggested` on open.
- **Uploading an exam timetable photo.** Text input only.
- **Sending phone-calendar busy times to the scheduler.**
- **More than 3 subjects.** The category limit is 3 today; see [planner.md](planner.md).
