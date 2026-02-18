const dns = require('dns');
const mongoose = require('mongoose');

const DEFAULT_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

function parseDnsServers(value) {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shouldRetryWithDnsFallback(error, uri) {
  const isSrvUri = typeof uri === 'string' && uri.trim().toLowerCase().startsWith('mongodb+srv://');
  const isSrvLookupRefused =
    error?.code === 'ECONNREFUSED' && /querySrv/i.test(String(error?.message || ''));

  return isSrvUri && isSrvLookupRefused;
}

function resolveDnsFallbackServers() {
  const fromEnv = parseDnsServers(process.env.MONGODB_DNS_SERVERS);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_DNS_SERVERS;
}

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
    if (shouldRetryWithDnsFallback(error, uri)) {
      const dnsServers = resolveDnsFallbackServers();

      try {
        dns.setServers(dnsServers);
        // eslint-disable-next-line no-console
        console.warn(
          `⚠️ MongoDB SRV DNS lookup failed (${error.code}). Retrying with DNS servers: ${dnsServers.join(', ')}`
        );

        await mongoose.connect(uri, {
          autoIndex: true,
        });
        // eslint-disable-next-line no-console
        console.log('✅ MongoDB connected');
        return;
      } catch (retryError) {
        // eslint-disable-next-line no-console
        console.error('❌ MongoDB connection error:', retryError.message);
        process.exit(1);
      }
    }

    // eslint-disable-next-line no-console
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

module.exports = connectDB;
