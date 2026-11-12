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
  return getHandler()(req, res);
}
