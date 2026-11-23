import mongoose from 'mongoose';

// A schedule of study blocks built by services/planner/scheduler.js.
//
//   DRAFT     a preview the user hasn't approved yet (at most one per user;
//             a new preview replaces it). Never shown as "the plan".
//   ACTIVE    the approved plan (at most one per user).
//   ARCHIVED  replaced by a newer approved plan. Kept for history.
//
// Nothing becomes ACTIVE without an explicit approve call.

export const PLAN_STATUSES  = Object.freeze(['DRAFT', 'ACTIVE', 'ARCHIVED']);
export const BLOCK_KINDS    = Object.freeze(['STUDY', 'REVIEW']);
export const BLOCK_STATUSES = Object.freeze(['PLANNED', 'IN_PROGRESS', 'DONE', 'MISSED', 'SKIPPED']);

const BlockSchema = new mongoose.Schema({
  taskId:          { type: mongoose.Schema.Types.ObjectId, ref: 'StudyTask', required: true },
  categoryId:      { type: String, required: true },
  dateStr:         { type: String, required: true },            // local day, user's zone
  startMinute:     { type: Number, required: true, min: 0, max: 1439 },
  durationMinutes: { type: Number, required: true, min: 5, max: 480 },
  kind:            { type: String, enum: BLOCK_KINDS, default: 'STUDY' },
  status:          { type: String, enum: BLOCK_STATUSES, default: 'PLANNED' },
  sessionId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
  // Moved by the user: re-planning never moves it.
  locked:          { type: Boolean, default: false },
});

const WarningSchema = new mongoose.Schema({
  code:    { type: String, required: true },   // NOT_ENOUGH_TIME | DEADLINE_TOO_SOON | PLAN_CHANGED
  taskId:  { type: mongoose.Schema.Types.ObjectId, default: null },
  minutes: { type: Number, default: null },    // unscheduled minutes (NOT_ENOUGH_TIME)
  message: { type: String, required: true },
}, { _id: false });

const StudyPlanSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status:  { type: String, enum: PLAN_STATUSES, default: 'DRAFT' },
  reason:  { type: String, enum: ['PREVIEW', 'REPLAN'], default: 'PREVIEW' },
  timezone: { type: String, required: true },
  generatedAt: { type: Date, default: Date.now },
  approvedAt:  { type: Date, default: null },
  // Set on the old plan when a draft replaces it. If the server stops between
  // archiving this plan and activating the draft, getActivePlan() finishes
  // the approval (see planService.approveDraft).
  supersededBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  explanation:       { type: String, default: '' },
  explanationSource: { type: String, enum: ['llm', 'fallback'], default: 'fallback' },
  warnings: { type: [WarningSchema], default: [] },
  blocks:   { type: [BlockSchema], default: [] },
}, { timestamps: true });

StudyPlanSchema.index({ userId: 1, status: 1 });
// At most one DRAFT and one ACTIVE plan per user, enforced by the database
// (two previews or approvals at the same instant can't both win).
StudyPlanSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'DRAFT' }, name: 'one_draft_per_user' });
StudyPlanSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_per_user' });

const pad = (n) => String(n).padStart(2, '0');
export const minuteToHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

StudyPlanSchema.statics.blockRecord = function (b, taskTitles = {}) {
  const taskId = b.taskId.toString();
  return {
    id:              b._id.toString(),
    taskId,
    taskTitle:       taskTitles[taskId] ?? null,
    categoryId:      b.categoryId,
    dateStr:         b.dateStr,
    startMinute:     b.startMinute,
    startTime:       minuteToHHMM(b.startMinute),
    endTime:         minuteToHHMM(b.startMinute + b.durationMinutes),
    durationMinutes: b.durationMinutes,
    kind:            b.kind,
    status:          b.status,
    sessionId:       b.sessionId ? b.sessionId.toString() : null,
    locked:          Boolean(b.locked),
  };
};

StudyPlanSchema.statics.toRecord = function (doc, taskTitles = {}) {
  const blocks = [...doc.blocks]
    .sort((a, b) => (a.dateStr === b.dateStr ? a.startMinute - b.startMinute : a.dateStr < b.dateStr ? -1 : 1))
    .map(b => this.blockRecord(b, taskTitles));
  return {
    id:                doc._id.toString(),
    status:            doc.status,
    reason:            doc.reason,
    timezone:          doc.timezone,
    generatedAt:       doc.generatedAt,
    approvedAt:        doc.approvedAt ?? null,
    explanation:       doc.explanation,
    explanationSource: doc.explanationSource,
    warnings: (doc.warnings ?? []).map(w => ({
      code: w.code, taskId: w.taskId ? w.taskId.toString() : null, minutes: w.minutes ?? null, message: w.message,
    })),
    totals: {
      blocks:  blocks.length,
      minutes: blocks.reduce((a, b) => a + b.durationMinutes, 0),
    },
    blocks,
  };
};

export default mongoose.model('StudyPlan', StudyPlanSchema);
