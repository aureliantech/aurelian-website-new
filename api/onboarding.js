// /api/onboarding.js
// Saves each client's onboarding checklist as one JSON file in your existing
// private Vercel Blob store (same store call-flows.html uses, under "onboarding/").
//
//   GET    /api/onboarding            -> list of clients (name + progress) for the "All clients" page
//   GET    /api/onboarding?id=...     -> one client's full checklist
//   POST   { id, name, create:true }  -> create a client
//   POST   { id, patch, summary }     -> save changes (merged, so two people editing at once don't erase each other)
//   DELETE /api/onboarding?id=...     -> delete a client

import { put, get, list, del } from '@vercel/blob';

const PREFIX = 'onboarding/';
const pathOf = (id) => `${PREFIX}${id}.json`;
const validId = (id) => typeof id === 'string' && /^[a-z0-9-]{3,90}$/.test(id);

// Always read the latest version (skip the cache), so a refresh shows what was just saved.
async function read(id) {
  try {
    const r = await get(pathOf(id), { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return { rec: await new Response(r.stream).json(), etag: r.blob && r.blob.etag };
  } catch (e) {
    if (e && /not.?found/i.test(e.name + e.message)) return null;
    throw e;
  }
}

function write(id, rec, opts = {}) {
  return put(pathOf(id), JSON.stringify(rec), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: opts.overwrite !== false,
    ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
  });
}

// Apply only the keys that changed. A null value means "removed".
function merge(target, patch) {
  const out = { ...(target || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const { id } = req.query;
      if (id) {
        if (!validId(id)) return res.status(400).json({ error: 'Bad id' });
        const found = await read(id);
        if (!found) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(found.rec);
      }
      let blobs = [], cursor;
      do {
        const page = await list({ prefix: PREFIX, cursor });
        blobs = blobs.concat(page.blobs);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      const clients = await Promise.all(blobs.map(async (b) => {
        const cid = b.pathname.slice(PREFIX.length).replace(/\.json$/, '');
        const found = await read(cid).catch(() => null);
        if (!found) return null;
        const { name, created, updated, summary } = found.rec;
        return { id: cid, name, created, updated, summary };
      }));
      return res.status(200).json(clients.filter(Boolean));
    }

    if (req.method === 'POST') {
      const { id, name, create, patch, summary } = req.body || {};
      if (!validId(id)) return res.status(400).json({ error: 'Bad id' });

      if (create) {
        if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing name' });
        const now = Date.now();
        const rec = { id, name: name.trim().slice(0, 120), created: now, updated: now, checks: {}, info: {}, summary: null };
        await write(id, rec, { overwrite: false });
        return res.status(200).json(rec);
      }

      // Read, merge, write. If someone else saved in between, try again with their version.
      for (let attempt = 0; attempt < 5; attempt++) {
        const found = await read(id);
        if (!found) return res.status(404).json({ error: 'Not found' });
        const rec = found.rec;
        rec.checks = merge(rec.checks, patch && patch.checks);
        rec.info = merge(rec.info, patch && patch.info);
        if (summary) rec.summary = summary;
        rec.updated = Date.now();
        try {
          await write(id, rec, { ifMatch: found.etag });
          return res.status(200).json(rec);
        } catch (e) {
          if (e && /precondition/i.test(e.name + e.message)) continue;
          throw e;
        }
      }
      return res.status(409).json({ error: 'Busy, try again' });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!validId(id)) return res.status(400).json({ error: 'Bad id' });
      await del(pathOf(id));
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).end('Method not allowed');
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
