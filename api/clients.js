// /api/clients.js
// Serverless API route for Vercel. Stores each saved client's call-flow HTML
// as a small JSON blob in Vercel Blob storage (private store), so every
// device that opens call-flows.html sees the same saved clients.
//
// Setup (one-time):
//   1. In your Vercel project dashboard: Storage tab -> Create Database -> Blob.
//      (Private is the default now — that's correct, this code expects it.)
//   2. In your project folder: npm install @vercel/blob
//   3. Commit/redeploy (or `vercel --prod` if you deploy via the CLI).

import { put, list, get, del } from '@vercel/blob';

async function streamToJSON(stream) {
  // result.stream is a Web ReadableStream; the global Response class can
  // consume it directly, same as reading a fetch() response body.
  return new Response(stream).json();
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { id } = req.query;

      if (id) {
        // Single-client fetch — used by the client-facing onboarding link, so
        // that page's network response never contains any other client's data.
        const result = await get(`clients/${id}.json`, { access: 'private' });
        if (!result || result.statusCode !== 200) {
          return res.status(404).json({ error: 'Not found' });
        }
        const data = await streamToJSON(result.stream);
        return res.status(200).json({ id, name: data.name, html: data.html });
      }

      const { blobs } = await list({ prefix: 'clients/' });
      const clients = await Promise.all(
        blobs.map(async (b) => {
          const result = await get(b.pathname, { access: 'private' });
          if (!result || result.statusCode !== 200) return null;
          const data = await streamToJSON(result.stream);
          const cid = b.pathname.replace(/^clients\//, '').replace(/\.json$/, '');
          return { id: cid, name: data.name, html: data.html };
        })
      );
      return res.status(200).json(clients.filter(Boolean));
    }

    if (req.method === 'POST') {
      const { id, name, html } = req.body || {};
      if (!id || !name || typeof html !== 'string') {
        return res.status(400).json({ error: 'Missing id, name, or html' });
      }
      await put(`clients/${id}.json`, JSON.stringify({ name, html }), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await del(`clients/${id}.json`);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).end('Method not allowed');
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
