const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/toing-bot';
  mongoose.set('strictQuery', false);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000
  });
  console.log('[DB] MongoDB connected');
}

module.exports = connectDB;
