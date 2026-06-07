import mongoose from 'mongoose';

const TaskSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    name: { type: String, required: true },
    priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
}, { timestamps: true });

TaskSchema.index({ userId: 1 });

export default mongoose.model('Task', TaskSchema);