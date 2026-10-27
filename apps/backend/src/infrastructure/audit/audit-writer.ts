import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type AuditAction,
} from '../../common/constants/audit-actions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../database/index.js';

export interface AuditEntry {
  readonly actorId: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata?: Prisma.InputJsonObject;
}

/**
 * The only writer of `audit_logs` (Decision 78). It takes the caller's transaction, so the audit row commits or rolls back
 * together with the change it records. The action is checked against the constant list before any SQL runs; which modules
 * may call it is enforced by the dependency-cruiser rule `audit-only-by-audited-modules`.
 */
@Injectable()
export class AuditWriter {
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    if (!Object.hasOwn(AUDIT_ACTIONS, entry.action)) {
      throw new TypeError(
        `AuditWriter: "${String(entry.action)}" is not a known audit action`,
      );
    }
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata ?? {},
      },
    });
  }
}
