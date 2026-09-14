const mongoose = require('mongoose');
const { createBrainFailureReporter } = require('@librechat/api');

let indexes;
const reportBrainFailure = createBrainFailureReporter(async (entry) => {
  const collection = mongoose.connection.collection('eucowork_client_errors');
  indexes ??= collection
    .createIndex({ at: 1 }, { expireAfterSeconds: 30 * 86400 })
    .catch((error) => {
      indexes = undefined;
      throw error;
    });
  await indexes;
  const userId = entry.user.id;
  const profile = mongoose.isValidObjectId(userId)
    ? await mongoose.connection
        .collection('users')
        .findOne(
          { _id: new mongoose.Types.ObjectId(userId) },
          { projection: { email: 1, name: 1 } },
        )
    : null;
  if (profile) entry.user = { ...entry.user, email: profile.email, name: profile.name };
  await collection.insertOne(entry);
});

module.exports = { reportBrainFailure };
