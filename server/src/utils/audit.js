import { db } from '../db.js';

const insertStmt = db.prepare(`
  INSERT INTO audit_logs (actor_type, actor_id, actor_label, action, target_type, target_id, details, ip)
  VALUES (@actor_type, @actor_id, @actor_label, @action, @target_type, @target_id, @details, @ip)
`);

/**
 * Record an administrative or device action for accountability and investigations.
 * (Proposal 5.5 Administrative Control & Logging)
 */
export function audit({
  actorType = 'user',
  actorId = null,
  actorLabel = null,
  action,
  targetType = null,
  targetId = null,
  details = null,
  ip = null,
}) {
  insertStmt.run({
    actor_type: actorType,
    actor_id: actorId,
    actor_label: actorLabel,
    action,
    target_type: targetType,
    target_id: targetId != null ? String(targetId) : null,
    details: details ? JSON.stringify(details) : null,
    ip,
  });
}
