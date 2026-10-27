import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/index.js';
import {
  PageQueryDto,
  pageWindow,
} from '../../../common/dto/page-query.dto.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { BlockedUsersPageDto } from '../dto/moderation.dto.js';
import { BlockService } from '../services/block.service.js';

@ApiTags('Moderation')
@ApiBearerAuth('access-token')
@Controller('me/blocks')
export class BlocksController {
  constructor(private readonly blocks: BlockService) {}

  @Get()
  @ApiOperation({
    summary: 'The people you have blocked',
    description:
      'Only your own blocks, newest first. There is no way to see who has blocked you.',
  })
  @ApiOkResponse({ type: BlockedUsersPageDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<BlockedUsersPageDto> {
    const window = pageWindow(query);
    const { items, total } = await this.blocks.list(user.id, window);
    return { items, page: window.page, pageSize: window.pageSize, total };
  }

  @Put(':userId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Block a user',
    description:
      'Idempotent. A block stops new direct messages and adding you to new groups between the two of you; it does not affect courses, enrollment or old history. An Admin cannot be blocked.',
  })
  @ApiNoContentResponse({ description: 'Blocked (or already blocked).' })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'CANNOT_BLOCK_SELF.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'CANNOT_BLOCK_ADMIN.',
  })
  async block(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.blocks.block(user.id, userId);
  }

  @Delete(':userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unblock a user', description: 'Idempotent.' })
  @ApiNoContentResponse({ description: 'Unblocked (or was not blocked).' })
  async unblock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.blocks.unblock(user.id, userId);
  }
}
