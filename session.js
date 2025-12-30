import express from 'express';
import { Session } from './mongo.js'; // Make sure this path matches your project

const router = express.Router();

// GET session by token
router.get('/:token', async (req, res) => {
  try {
    const token = req.params.token;

    const record = await Session.findOne({ key: token });

    if (!record) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    res.json({
      key: record.key,
      value: record.value,
      status: record.status || 'unknown',
      lastError: record.lastError || null,
      notified: record.notified || false,
      notifiedAt: record.notifiedAt || null
    });
  } catch (err) {
    console.error('Error fetching session:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;