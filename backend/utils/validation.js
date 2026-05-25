import mongoose from 'mongoose';

/**
 * Guard `:id`-style route params against malformed ObjectIds before they reach
 * Mongo. Sends a 400 and returns false when invalid; returns true otherwise.
 *
 * Usage at the top of any route with an id param:
 *   if (!assertObjectId(req.params.id, res)) return;
 */
export function assertObjectId(id, res) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ message: 'Invalid id' });
    return false;
  }
  return true;
}
