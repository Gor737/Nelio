import { Injectable } from '@nestjs/common';
import { pageWindow } from '../../../common/dto/page-query.dto.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import { TransactionService } from '../../../infrastructure/database/index.js';
import { CatalogAdminService, CatalogService } from '../../catalog/index.js';
import type {
  AdminCategoryDto,
  AdminTagsPageDto,
  AdminTagsQueryDto,
  TagMergeResultDto,
} from '../dto/admin.dto.js';

/**
 * Admin: categories and tags (Decisions 44, 62, 133). Catalog does the writes; Admin wraps each one in a transaction with its audit row
 * (the `CATEGORY_*` and `TAG_MERGED` actions are Admin's).
 */
@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly audit: AuditWriter,
    private readonly catalog: CatalogAdminService,
    private readonly reads: CatalogService,
  ) {}

  categories(): Promise<AdminCategoryDto[]> {
    return this.reads.listCategories();
  }

  createCategory(actorId: string, name: unknown): Promise<AdminCategoryDto> {
    return this.transactions.run(async (tx) => {
      const category = await this.catalog.createCategory(tx, name);
      await this.audit.record(tx, {
        actorId,
        action: 'CATEGORY_CREATED',
        targetType: 'CATEGORY',
        targetId: category.id,
        metadata: { name: category.name },
      });
      return category;
    });
  }

  renameCategory(
    actorId: string,
    id: string,
    name: unknown,
  ): Promise<AdminCategoryDto> {
    return this.transactions.run(async (tx) => {
      const { before, after } = await this.catalog.renameCategory(tx, id, name);
      await this.audit.record(tx, {
        actorId,
        action: 'CATEGORY_UPDATED',
        targetType: 'CATEGORY',
        targetId: id,
        metadata: { from: before.name, to: after.name },
      });
      return after;
    });
  }

  deleteCategory(actorId: string, id: string): Promise<void> {
    return this.transactions.run(async (tx) => {
      const category = await this.catalog.deleteCategory(tx, id);
      await this.audit.record(tx, {
        actorId,
        action: 'CATEGORY_DELETED',
        targetType: 'CATEGORY',
        targetId: id,
        metadata: { name: category.name },
      });
    });
  }

  async tags(query: AdminTagsQueryDto): Promise<AdminTagsPageDto> {
    const { page, pageSize, offset } = pageWindow(query);
    const { items, total } = await this.catalog.listTags(query.q, {
      limit: pageSize,
      offset,
    });
    return { items, page, pageSize, total };
  }

  mergeTags(
    actorId: string,
    sourceId: string,
    targetId: string,
  ): Promise<TagMergeResultDto> {
    return this.transactions.run(async (tx) => {
      const { source, target, result } = await this.catalog.mergeTags(
        tx,
        sourceId,
        targetId,
      );
      await this.audit.record(tx, {
        actorId,
        action: 'TAG_MERGED',
        targetType: 'TAG',
        targetId: targetId,
        metadata: {
          sourceId,
          sourceName: source.name,
          targetName: target.name,
          moved: result.moved,
          alreadyTagged: result.alreadyTagged,
        },
      });
      return result;
    });
  }
}
