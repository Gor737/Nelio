import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { TransactionService } from './transaction.service.js';

@Global()
@Module({
  providers: [PrismaService, TransactionService],
  exports: [PrismaService, TransactionService],
})
export class DatabaseModule {}
