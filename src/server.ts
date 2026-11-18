import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {ensureSeeded, getDb} from './server/db';
import {startDailyReportScheduler} from './server/mailer';
import {ensureMysqlDatabaseAndSchema} from './server/mysql-connector';
import {createApiRouter} from './server/routes';
import {notificationHub} from './server/ws';

try {
  (process as unknown as {loadEnvFile?: () => void}).loadEnvFile?.();
} catch {
  // Optional .env file
}

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Initialize DB, seed fixed Super Admin, bootstrap dedicated RDS database & start 24h Excel email scheduler
getDb();
void ensureSeeded(
  process.env['APP_URL'] && process.env['APP_URL'] !== 'MY_APP_URL'
    ? process.env['APP_URL']
    : 'http://localhost:3000',
).then(() => {
  startDailyReportScheduler();
  void ensureMysqlDatabaseAndSchema();
});

app.use(express.json({limit: '6mb'}));
app.use(express.urlencoded({extended: true, limit: '6mb'}));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// WebSocket upgrade route for real-time notifications BEFORE Angular SSR
const wss = notificationHub.getServer();
app.use('/api/ws', (req, res, next) => {
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  next();
});

// Mount REST API v1
app.use('/api/v1', createApiRouter());

// Serve static files from /browser
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

// Angular SSR catch-all must be LAST
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

const server = createServer(app);

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 3000;
  server.listen(port, () => {
    console.log(`Secure QR Verification server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
