import mongoose from 'mongoose';
import type { IConversation } from '@librechat/data-schemas';
import { deleteBrainSources, BrainServiceError } from './client';

export async function purgeBrainConversations(
  userId: string,
  conversationId?: string,
): Promise<string[] | undefined> {
  if (!process.env.BRAIN_API_URL) {
    return undefined;
  }
  if (!process.env.BRAIN_SHARED_SECRET) {
    throw new BrainServiceError(503);
  }
  const Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  const rows = await Conversation.find({
    user: userId,
    ...(conversationId ? { conversationId } : {}),
  })
    .select('conversationId')
    .lean<Pick<IConversation, 'conversationId'>[]>();
  const ids = rows.map((row) => row.conversationId);
  for (let index = 0; index < ids.length; index += 200) {
    await deleteBrainSources(userId, ids.slice(index, index + 200));
  }
  return ids;
}
