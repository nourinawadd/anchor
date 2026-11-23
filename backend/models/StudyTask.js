import mongoose from 'mongoose';

// Something the user has to study for: an exam, quiz, assignment or plain
// study goal, tied to one of their categories (subjects). The planner turns
// open tasks into StudyPlan blocks. See docs/planner.md.

export const TASK_KINDS    = Object.freeze(['EXAM', 'QUIZ', 'ASSIGNMENT', 'STUDY']);
export const TASK_STATUSES = Object.freeze(['OPEN', 'DONE', 'CANCELLED']);
export const MAX_OPEN_TASKS = 60;

const StudyTaskSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  categoryId: { type: String, required: true },                 // User.categories[].id
  title:      { type: String, required: true, trim: true, maxlength: 100 },
  kind:       { type: String, enum: TASK_KINDS, default: 'STUDY' },
  // Local calendar date the task is due (exam day). Study is planned on days
  // BEFORE it; nothing is scheduled on or after the deadline.
  deadline:     { type: String, required: true },               // YYYY-MM-DD, user's zone
  deadlineTime: { type: String, default: null },                // "HH:MM" (display only)
  difficulty:   { type: Number, enum: [1, 2, 3], default: 2 },  // 1 easy · 2 medium · 3 hard
  estimatedMinutes: { type: Number, required: true, min: 15, max: 6000 },
  // Focus minutes from sessions started from this task's plan blocks.
  completedMinutes: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: TASK_STATUSES, default: 'OPEN' },
  source: { type: String, enum: ['AI', 'MANUAL'], default: 'MANUAL' },
}, { timestamps: true });

StudyTaskSchema.index({ userId: 1, status: 1, deadline: 1 });

StudyTaskSchema.virtual('remainingMinutes').get(function () {
  return Math.max(0, this.estimatedMinutes - this.completedMinutes);
});

StudyTaskSchema.statics.toRecord = function (doc) {
  return {
    id:               doc._id.toString(),
    categoryId:       doc.categoryId,
    title:            doc.title,
    kind:             doc.kind,
    deadline:         doc.deadline,
    deadlineTime:     doc.deadlineTime ?? null,
    difficulty:       doc.difficulty,
    estimatedMinutes: doc.estimatedMinutes,
    completedMinutes: doc.completedMinutes,
    remainingMinutes: Math.max(0, doc.estimatedMinutes - doc.completedMinutes),
    status:           doc.status,
    source:           doc.source,
  };
};

export default mongoose.model('StudyTask', StudyTaskSchema);
