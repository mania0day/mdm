import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { db, initSchema } from './db.js';
import { config } from './config.js';
import { POLICY_SCHEMA } from './services/policyEngine.js';

/**
 * Idempotent bootstrap: ensure schema, a super-admin, a default policy,
 * and one ready-to-use enrollment token exist. Safe to run on every start.
 * Returns any freshly generated enrollment token so it can be surfaced in logs.
 */
export function seed() {
  initSchema();

  // Seed super-admin if there are no users at all.
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync(config.seedAdmin.password, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
    ).run(config.seedAdmin.username, hash, config.seedAdmin.name, 'super_admin');
  }

  // Seed a default policy.
  const policyCount = db.prepare('SELECT COUNT(*) c FROM policies').get().c;
  if (policyCount === 0) {
    db.prepare(
      'INSERT INTO policies (name, description, config, is_default) VALUES (?, ?, ?, 1)',
    ).run(
      'Baseline Security Policy',
      'Default organizational security baseline applied to newly enrolled devices.',
      JSON.stringify(POLICY_SCHEMA),
    );
    db.prepare(
      'INSERT INTO policies (name, description, config, is_default) VALUES (?, ?, ?, 0)',
    ).run(
      'High-Security (Field Ops)',
      'Hardened policy for field operation devices: complex password, camera disabled, wipe after 5 failed unlocks.',
      JSON.stringify({
        ...POLICY_SCHEMA,
        min_password_length: 8,
        password_quality: 'complex',
        max_failed_passwords: 5,
        disable_camera: true,
        max_screen_timeout_seconds: 60,
      }),
    );
  }

  // Forward-migration: backfill any policy-schema keys added after a policy was
  // first stored (e.g. force_location_on) so existing policies stay complete and
  // newly-added enforcement features actually take effect. Idempotent.
  const allPolicies = db.prepare('SELECT id, config FROM policies').all();
  const updateCfg = db.prepare('UPDATE policies SET config = ?, updated_at = datetime(\'now\') WHERE id = ?');
  for (const p of allPolicies) {
    let cfg;
    try { cfg = JSON.parse(p.config); } catch { cfg = {}; }
    let changed = false;
    for (const [k, v] of Object.entries(POLICY_SCHEMA)) {
      if (!(k in cfg)) { cfg[k] = v; changed = true; }
    }
    if (changed) updateCfg.run(JSON.stringify(cfg), p.id);
  }

  // Ensure at least one unused enrollment token exists for quick testing.
  const openToken = db
    .prepare('SELECT * FROM enrollment_tokens WHERE used = 0 LIMIT 1')
    .get();
  let token = openToken?.token;
  if (!openToken) {
    token = `ENR-${nanoid(16)}`;
    db.prepare(
      'INSERT INTO enrollment_tokens (token, label, department) VALUES (?, ?, ?)',
    ).run(token, 'Default demo token', 'Operations');
  }
  return { enrollmentToken: token };
}

// Allow running as a standalone script: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { enrollmentToken } = seed();
  // eslint-disable-next-line no-console
  console.log('Seed complete. Enrollment token:', enrollmentToken);
}
