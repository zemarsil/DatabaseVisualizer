import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_HOST, createDbContainer, describeDockerError, dockerStatus, listDbContainers, removeContainer, startContainer, stopContainer } from './docker';
import { applyStatements, friendlyDbError, introspect, testConnection, validateConnection } from './db/index';
import type { ApplySchemaRequest, CreateContainerRequest } from '../src/shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const VERSION = '0.1.0';

const app = express();
app.use(express.json({ limit: '10mb' }));
// The Vite dev server proxies /api, but allow direct calls from localhost origins too.
app.use(cors({ origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] }));

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, defaultDbHost: DEFAULT_DB_HOST });
});

/* ---------------- Docker ---------------- */

app.get(
  '/api/docker/status',
  wrap(async (_req, res) => {
    res.json(await dockerStatus());
  }),
);

app.get(
  '/api/docker/containers',
  wrap(async (_req, res) => {
    try {
      res.json(await listDbContainers());
    } catch (e) {
      res.status(503).json({ error: describeDockerError(e) });
    }
  }),
);

app.post(
  '/api/docker/containers',
  wrap(async (req, res) => {
    const body = req.body as CreateContainerRequest;
    try {
      res.json(await createDbContainer(body));
    } catch (e) {
      res.status(400).json({ error: describeDockerError(e) });
    }
  }),
);

for (const [action, fn] of [
  ['start', startContainer],
  ['stop', stopContainer],
  ['remove', removeContainer],
] as const) {
  app.post(
    `/api/docker/containers/:id/${action}`,
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
        res.status(400).json({ error: 'Invalid container id.' });
        return;
      }
      try {
        await fn(id);
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: describeDockerError(e) });
      }
    }),
  );
}

/* ---------------- Database ---------------- */

app.post(
  '/api/db/test',
  wrap(async (req, res) => {
    let cfg;
    try {
      cfg = validateConnection(req.body);
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
      return;
    }
    try {
      const serverVersion = await testConnection(cfg);
      res.json({ ok: true, serverVersion });
    } catch (e) {
      res.json({ ok: false, error: friendlyDbError(e) });
    }
  }),
);

app.post(
  '/api/db/apply',
  wrap(async (req, res) => {
    const body = req.body as Partial<ApplySchemaRequest>;
    let cfg;
    try {
      cfg = validateConnection(body.connection);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    const statements = Array.isArray(body.statements) ? body.statements.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
    if (statements.length === 0) {
      res.status(400).json({ error: 'No statements to run.' });
      return;
    }
    try {
      const results = await applyStatements(cfg, statements, body.stopOnError !== false);
      res.json({ ok: results.every((r) => r.ok), results });
    } catch (e) {
      res.status(502).json({ error: friendlyDbError(e) });
    }
  }),
);

app.post(
  '/api/db/introspect',
  wrap(async (req, res) => {
    let cfg;
    try {
      cfg = validateConnection(req.body);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    try {
      res.json(await introspect(cfg));
    } catch (e) {
      res.status(502).json({ error: friendlyDbError(e) });
    }
  }),
);

/* ---------------- Static client (production) ---------------- */

const distDir = path.resolve(__dirname, '..', 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((req, res) => {
  if (req.path.startsWith('/api/')) res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
  else res.status(404).send('Not found. In production, run "npm run build" first so the client is served from dist/.');
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api]', message);
  res.status(500).json({ error: message });
});

app.listen(PORT, HOST, () => {
  console.log(`Database Visualizer API listening on http://${HOST}:${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    console.log(fs.existsSync(distDir) ? `Serving the client from ${distDir}` : 'dist/ not found: run "npm run build" to serve the client from here.');
  }
});
