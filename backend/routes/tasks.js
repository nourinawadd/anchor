import express from 'express';
import Task from '../models/Task.js';
import auth from '../middleware/auth.js';

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
    try {
        const tasks = await Task.find({ userId: req.user._id }).sort({ createdAt: 1 });
        res.json(tasks);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const { name, priority } = req.body;
        if (!name) return res.status(400).json({ message: 'Name is required' });
        const task = await Task.create({
            userId: req.user._id,
            name: name.trim(),
            priority: priority || 'medium',
        });
        res.status(201).json(task);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const task = await Task.findOneAndDelete({
            _id: req.params.id,
            userId: req.user._id,
        });
        if (!task) return res.status(404).json({ message: 'Task not found' });
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

export default router;
