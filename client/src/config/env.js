const DEV_FALLBACK_API = 'http://localhost:5000';

const sanitize = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
};

const isHttpUrl = (value) => /^https?:\/\//.test(value);

const resolvedApi = sanitize(import.meta.env.VITE_API_URL);
export const API_URL = resolvedApi || (import.meta.env.DEV ? DEV_FALLBACK_API : '');

const resolvedSocket = sanitize(import.meta.env.VITE_SOCKET_URL);
export const SOCKET_URL = resolvedSocket || (isHttpUrl(API_URL) ? API_URL : '');
