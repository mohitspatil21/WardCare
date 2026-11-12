import { createAppHandler } from '../server.js';

let cached;

function getHandler() {
  if (!cached) {
    cached = createAppHandler({
      dbPath: process.env.WARD_DB || '/tmp/ward-care.db',
      seed: true,
      enableTimers: false,
    });
  }
  return cached.handler;
}

/** Vercel Serverless Function entrypoint forwarding all UI and API routes to WardCare. */
export default async function handler(req, res) {
  try {
    return await getHandler()(req, res);
  } catch (err) {
    console.error('WardCare Vercel invocation error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: err?.message || 'Server initialization failed' }));
  }
}
