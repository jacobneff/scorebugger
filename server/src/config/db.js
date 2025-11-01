const mongoose = require('mongoose');

async function connectDB() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const primaryKey = isProd ? 'MONGODB_URI_PROD' : 'MONGODB_URI_DEV';
  const uri = process.env[primaryKey] || process.env.MONGODB_URI;

  if (!uri) {
    throw new Error(
      `${primaryKey} is not set and MONGODB_URI is not available as a fallback`
    );
  }

  try {
    await mongoose.connect(uri, {
      autoIndex: true,
    });
    // eslint-disable-next-line no-console
    console.log('✅ MongoDB connected');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

module.exports = connectDB;
