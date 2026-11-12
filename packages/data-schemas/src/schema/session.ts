import mongoose, { Schema } from 'mongoose';
import { ISession } from '~/types';

const sessionSchema: Schema<ISession> = new Schema({
  securityAssurance: {
    type: { method: String, verifiedAt: Number, version: Number },
    default: undefined,
  },
  refreshTokenHash: {
    type: String,
    required: true,
  },
  expiration: {
    type: Date,
    required: true,
    expires: 0,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

export default sessionSchema;
