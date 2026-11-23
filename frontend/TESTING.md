# Frontend Manual QA Checklist — Anchor (Focus Ecosystem)

The backend is covered by an automated Vitest suite (`backend/test/`, run with `npm --prefix backend test`).
The React Native app uses a **custom dev client** with native modules (`anchor-screen-time`, NFC, Screen
Time / Family Controls), so it is verified **manually** against a development build — **never Expo Go**.

## Setup

1. Start the backend: `npm --prefix backend run dev` (needs a populated `.env`; see `backend/.env.example`).
2. Point the app at your backend: set `EXPO_PUBLIC_API_URL` in `frontend/.env`
   (or edit the base URL in `frontend/api/client.ts`) to your machine's LAN IP,
   e.g. `http://192.168.1.95:5000/api`, so the iPhone can reach it over Wi-Fi.
3. Launch Metro against the installed dev build: `npx expo start --dev-client`, then open the app.
4. To exercise social sign-in, configure Google/Apple client IDs (see `backend/.env.example`).

## How to use this checklist

Run every section **once per account type** and record the result in the table at the bottom:

- **Password** — email + password sign-up
- **Google** — native Google sign-in
- **Apple** — native Apple sign-in
- **Email-linked** — sign up with password, then sign in with Google/Apple using the **same email**
  (should land on the *same* account, not a duplicate)

Mark each row ✅ pass / ❌ fail / — n/a, and note anything surprising.

---

## 1. Authentication (`LoginScreen`, `SignUpScreen`)
- [ ] Sign up / sign in succeeds and lands on the Dashboard.
- [ ] Email-linked: signing in with a social provider using an existing password email reuses the same
      account (same data, same history — no duplicate/empty account).
- [ ] Kill and relaunch the app → session is restored (token refresh), no re-login required.
- [ ] Log out → returns to Login; protected screens are no longer reachable.

## 2. Session loop (`CreateSessionScreen`, `ActiveSessionScreen`, `SessionCompleteScreen`)
- [ ] Create a session in each timer mode: **Countdown**, **Pomodoro**, **Stopwatch**.
- [ ] Blocked-app / distraction events register during the session.
- [ ] NFC tag scan verifies presence (where a tag is registered).
- [ ] Complete a session → `SessionCompleteScreen` focus score matches the backend
      (cross-check `PATCH /api/sessions/:id/end` response).
- [ ] Abandon a session → it is recorded as abandoned with **no** focus score.
- [ ] Pomodoro completion shows the higher score (the +8 bonus is visible vs an equivalent countdown).

## 3. Dashboard & streaks (`DashboardScreen`)
- [ ] Completing a session today shows/increments the streak.
- [ ] **Grace period:** on a day where you haven't started a session yet, the streak from previous days
      still shows (it is NOT reset to 0 just because today is idle so far).
- [ ] After a fully skipped day, the next completed session resets the current streak to 1.
- [ ] Longest streak never decreases.

## 4. Analytics (`AnalyticsScreen`)
- [ ] Day / Week / Month filter cards switch the data and the bar chart.
- [ ] Total focus minutes, completion rate, average focus score, and best hour look correct.
- [ ] Bar chart minutes reflect **completed** sessions only (abandoned sessions don't add bars).
- [ ] Health score and its breakdown (consistency / completion / volume) respond to your goals.
- [ ] Spot-check the screen against `GET /api/analytics/summary?period=week` for the same account.

## 5. History (`HistoryScreen`)
- [ ] Past sessions list newest-first.
- [ ] Filters (status / date) narrow the list correctly.
- [ ] Opening a past session shows its details and score.

## 6. AI insights (`AIInsightsScreen`)
- [ ] With < 3 completed sessions: a friendly "not enough data" empty state (no crash).
- [ ] With ≥ 3 sessions and AI configured: an insight/schedule renders.
- [ ] With AI not configured: a clean "AI unavailable" state (no crash).

## 7. Settings & NFC (`SettingsScreen`, `ProfileScreen`, `NFCScreen`, `NFCSetupScreen`)
- [ ] Change daily/weekly goals → Analytics health-score targets shift accordingly.
- [ ] Change timezone → "today"/streak boundaries follow the new zone.
- [ ] Change default timer mode/duration → reflected on the next Create Session.
- [ ] Register an NFC tag, see it listed, delete it.
- [ ] Verify a registered tag → valid; an unknown tag → invalid.

## 8. Cross-cutting
- [ ] No console/red-box errors during any flow.
- [ ] Screen transitions (fade animations) and the drawer overlay behave on all listed screens.
- [ ] Backgrounding the app mid-session and returning keeps the timer state sane.

## 9. Custom Breaks (Countdown only)

**Setup:** until the backend supports breaks, add `EXPO_PUBLIC_MOCK_BREAKS=1` to `frontend/.env` and
restart with `npx expo start --dev-client -c`. Metro should log `[mock-breaks] Custom Breaks mock is ON`.
Use short sessions to keep runs quick (e.g. 10 min, a planned break after 1 min that lasts 1 min).
On **Create Session**, Pomodoro must be **off** for the *Breaks* section to appear.

**Planned break**
- [ ] Add one planned break (after 1 min, 1 min long) and start. After 1 min of focus the break starts
      by itself: ring shows the break countdown labelled **BREAK**, and "Focus resumes with mm:ss left"
      shows the focus time that was left.
- [ ] Pausing during focus delays the break by the paused time (only focus time counts toward it).
- [ ] When the break runs out, focus resumes on its own with exactly that saved time.
- [ ] The planned break does not fire a second time.
- [ ] End the session: the summary shows **six** cards — **Focus Time**, **Break Time**, **Breaks Taken**
      (= 1), Focus Score, Apps Blocked, Distractions. Focus Time excludes the break.
- [ ] History shows the session with "· 1 break" on its row.

**On-demand breaks**
- [ ] Set *Max breaks* = 3 and *Max total* = 10 min. During focus, **Take a break** appears next to Pause.
- [ ] Tap it: the sheet offers 5 / 10 / 15 min + Custom, with 15 disabled (longer than the 10 min left).
      Choose Custom → 3 min → the break starts only after the server confirms.
- [ ] End it early, open the sheet again: it says 7 min left, so 10 and 15 are disabled. Take 5 min.
- [ ] Open it once more: 2 min left, only Custom (1–2 min) works. Take 2 min.
- [ ] Afterwards the button is gone and "You've used all your breaks for this session" shows.
- [ ] The button is hidden while paused and during a break.
- [ ] The summary counts all three breaks (Breaks Taken = 3).

**Ending a break early**
- [ ] Note "Focus resumes with mm:ss left", tap **End break** mid-break → focus resumes with exactly that
      time (not reduced by the break).
- [ ] An on-demand break ended early still uses its full length from the allowance (no refund).

**App blocking** (needs Screen Time access and at least one app selected)
- [ ] Unlock setting **off**: blocked apps stay blocked during the break; top label reads "Break".
- [ ] Unlock setting **on**: blocked apps open during the break, and are blocked again as soon as focus
      resumes (both when the break runs out and after **End break**).
- [ ] Pausing during focus keeps apps blocked in both cases.

**Notifications & Live Activity** (lock the phone to check)
- [ ] During focus, the next alert is "Break starting" if a planned break comes before the session ends,
      otherwise "Session complete".
- [ ] During a break: "Break ends in 1 minute" (or "in 30 seconds" for breaks of 2 min or less).
- [ ] Live Activity shows **Break** with the break countdown, then switches back to **Focus**.

**Killing the app** (swipe it away from the app switcher, then reopen)
- [ ] Mid-break: reopening returns to the **same break** with the correct time left; afterwards focus
      resumes with the right time. With unlock **on**, apps are unblocked while still in the break.
- [ ] Mid-focus after a planned break: reopening resumes focus with the right time left, and the planned
      break does **not** fire again.
- [ ] Kill mid-break and wait past the break's end before reopening: focus resumes (no break).
- [ ] Notifications and Live Activity match whichever phase it reopens into.
- [ ] A resumed session keeps its real length (not 45 min).

**Pomodoro unchanged**
- [ ] Pomodoro on: no Breaks section on Create Session, no "Take a break" button.
- [ ] Focus/break rounds, app blocking (unblocked in Pomodoro breaks), notifications and Live Activity
      behave as before.
- [ ] Summary shows the usual four cards with **Duration**; History rows have no "· breaks".
- [ ] Killing and reopening mid-Pomodoro resumes the right round with its real number of rounds.

**If the break cards don't appear on the summary:** check the session's History row.
- Row shows "· N breaks" but the summary doesn't → bug in the end-of-session totals (note what you did).
- Row shows no breaks either → no break was recorded (check the mock is on, and that a break actually
  started before you ended the session).

---

## Results

| Feature area            | Password | Google | Apple | Email-linked | Notes |
|-------------------------|:--------:|:------:|:-----:|:------------:|-------|
| 1. Authentication       |          |        |       |              |       |
| 2. Session loop         |          |        |       |              |       |
| 3. Dashboard & streaks  |          |        |       |              |       |
| 4. Analytics            |          |        |       |              |       |
| 5. History              |          |        |       |              |       |
| 6. AI insights          |          |        |       |              |       |
| 7. Settings & NFC       |          |        |       |              |       |
| 8. Cross-cutting        |          |        |       |              |       |
| 9. Custom Breaks        |          |        |       |              |       |

_Tester: _______  Device / OS: _______  Build: _______  Date: ________
