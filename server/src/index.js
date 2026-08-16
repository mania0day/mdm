import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { seed } from './seed.js';
import { errorHandler } from './middleware/error.js';

import { authRouter } from './routes/auth.js';
import { devicesRouter } from './routes/devices.js';
import { agentRouter } from './routes/agent.js';
import { policiesRouter } from './routes/policies.js';
import { alertsRouter } from './routes/alerts.js';
import { auditRouter } from './routes/audit.js';
import { usersRouter } from './routes/users.js';
import { enrollmentRouter } from './routes/enrollment.js';
import { statsRouter } from './routes/stats.js';
import { startOfflineMonitor } from './services/offlineMonitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bootstrap DB, admin, policies, enrollment token.
const { enrollmentToken } = seed();

const app = express();
app.set('trust proxy', 1);

// Security headers. CSP is relaxed enough to serve the bundled dashboard SPA.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // CARTO basemap raster tiles for the device location map (OSM's own
        // tile server blocks embedded use). Tiles are <img> requests, so only
        // img-src needs the tile host.
        imgSrc: ["'self'", 'data:', 'https://*.basemaps.cartocdn.com'],
        connectSrc: ["'self'"],
        // Local demo is served over plain HTTP; do not force-upgrade sub-resource
        // requests to HTTPS (that would break asset loading on http://localhost).
        upgradeInsecureRequests: null,
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: '256kb' }));
if (config.env !== 'test') app.use(morgan('dev'));

// Rate-limit authentication and agent enrollment to blunt brute force.
const authLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true });
app.use('/api/auth/login', authLimiter);
app.use('/api/agent/enroll', rateLimit({ windowMs: 60_000, max: 20 }));

// Health check
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', service: 'SENTROID MDM Server', time: new Date().toISOString() }),
);

// API routes
app.use('/api/auth', authRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/agent', agentRouter);
app.use('/api/policies', policiesRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/audit-logs', auditRouter);
app.use('/api/users', usersRouter);
app.use('/api/enrollment', enrollmentRouter);
app.use('/api/stats', statsRouter);

// Serve the agent APK at a stable path for QR / zero-touch Device Owner
// provisioning downloads. Served from the apk/ folder (not dashboard/dist,
// which the Vite build wipes on every rebuild).
const apkPath = path.join(__dirname, '..', '..', 'apk', 'sentroid-agent.apk');
app.get('/sentroid-agent.apk', (req, res) => {
  if (fs.existsSync(apkPath)) {
    res.type('application/vnd.android.package-archive');
    res.sendFile(apkPath);
  } else {
    res.status(404).json({ error: 'APK not built yet — run android-agent/build-apk.sh' });
  }
});

// Serve the built dashboard (if present) as static SPA.
const dashboardDist = path.join(__dirname, '..', '..', 'dashboard', 'dist');
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res.json({
      service: 'SENTROID MDM Server',
      note: 'Dashboard not built yet. Run `npm run build` in ../dashboard, or use the dev server.',
      api: '/api/health',
    }),
  );
}

app.use(errorHandler);

// Background watchdog: log + alert when a managed device goes silent (the only
// server-observable signal that the agent was uninstalled / device powered off).
startOfflineMonitor();

app.listen(config.port, config.host, () => {
  /* eslint-disable no-console */
  console.log('\n============================================================');
  console.log('  SENTROID MDM Management Server');
  console.log('============================================================');
  console.log(`  API + Dashboard : http://localhost:${config.port}`);
  console.log(`  Health          : http://localhost:${config.port}/api/health`);
  console.log(`  From emulator   : http://10.0.2.2:${config.port}  (host loopback)`);
  console.log(`  Admin login     : ${config.seedAdmin.username} / ${config.seedAdmin.password}`);
  console.log(`  Demo enroll tok : ${enrollmentToken}`);
  console.log('============================================================\n');
  /* eslint-enable no-console */
});
