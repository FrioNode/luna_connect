import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URL = process.env.MONGO || 'mongodb://frio:node@localhost:27017/session?authSource=admin';

mongoose.connect(MONGO_URL)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(console.error);

const sessionSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: String,
  status: { type: String, default: 'pending' },
  lastError: { type: String, default: null },
  notified: { type: Boolean, default: false },
  notifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, expires: 432000 }
});

export const Session = mongoose.model('Session', sessionSchema);