import { Module } from '@nestjs/common';
import { AuditWriter } from './audit-writer.js';

@Module({ providers: [AuditWriter], exports: [AuditWriter] })
export class AuditModule {}
