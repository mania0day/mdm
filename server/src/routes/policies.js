import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { POLICY_SCHEMA } from '../services/policyEngine.js';
import { audit } from '../utils/audit.js';

export const policiesRouter = Router();
policiesRouter.use(requireAuth);

const listStmt = db.prepare(`
  SELECT p.*, (SELECT COUNT(*) FROM device_policies dp WHERE dp.policy_id = p.id) AS device_count
  FROM policies p ORDER BY p.is_default DESC, p.name ASC
`);
const getStmt = db.prepare('SELECT * FROM policies WHERE id = ?');

function parse(row) {
  return { ...row, config: JSON.parse(row.config || '{}') };
}

policiesRouter.get('/', (req, res) => {
  res.json({ policies: listStmt.all().map(parse), schema: POLICY_SCHEMA });
});

policiesRouter.get('/:id', (req, res) => {
  const p = getStmt.get(req.params.id);
  if (!p) throw httpError(404, 'Policy not found');
  res.json({ policy: parse(p) });
});

const policySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  config: z.record(z.any()).optional().default({}),
  is_default: z.boolean().optional().default(false),
});

policiesRouter.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = policySchema.parse(req.body);
    if (body.is_default) db.prepare('UPDATE policies SET is_default = 0').run();
    const info = db
      .prepare(
        `INSERT INTO policies (name, description, config, is_default, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        body.description,
        JSON.stringify({ ...POLICY_SCHEMA, ...body.config }),
        body.is_default ? 1 : 0,
        req.user.id,
      );
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'CREATE_POLICY',
      targetType: 'policy',
      targetId: info.lastInsertRowid,
      details: { name: body.name },
      ip: req.ip,
    });
    res.status(201).json({ policy: parse(getStmt.get(info.lastInsertRowid)) });
  }),
);

policiesRouter.put(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const existing = getStmt.get(req.params.id);
    if (!existing) throw httpError(404, 'Policy not found');
    const body = policySchema.partial().parse(req.body);
    if (body.is_default) db.prepare('UPDATE policies SET is_default = 0').run();
    const merged = {
      name: body.name ?? existing.name,
      description: body.description ?? existing.description,
      config: JSON.stringify({
        ...POLICY_SCHEMA,
        ...JSON.parse(existing.config || '{}'),
        ...(body.config || {}),
      }),
      is_default: body.is_default ? 1 : existing.is_default,
    };
    db.prepare(
      `UPDATE policies SET name=?, description=?, config=?, is_default=?, updated_at=datetime('now') WHERE id=?`,
    ).run(merged.name, merged.description, merged.config, merged.is_default, existing.id);
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'UPDATE_POLICY',
      targetType: 'policy',
      targetId: existing.id,
      ip: req.ip,
    });
    res.json({ policy: parse(getStmt.get(existing.id)) });
  }),
);

policiesRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const existing = getStmt.get(req.params.id);
    if (!existing) throw httpError(404, 'Policy not found');
    if (existing.is_default) throw httpError(400, 'Cannot delete the default policy');
    db.prepare('DELETE FROM policies WHERE id = ?').run(existing.id);
    audit({
      actorType: 'user',
      actorId: req.user.id,
      actorLabel: req.user.username,
      action: 'DELETE_POLICY',
      targetType: 'policy',
      targetId: existing.id,
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
