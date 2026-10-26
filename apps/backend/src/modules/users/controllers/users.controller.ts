import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimit } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { UserSearchQueryDto, UserSummaryDto } from '../dto/users.dto.js';
import { UsersService } from '../services/users.service.js';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RateLimit('TIGHT')
  @ApiOperation({
    summary: 'Search people by name',
    description:
      'Signed-in users only. `q` is at least 2 characters; at most 20 results, no pagination; suspended accounts are not listed. Only id, name and avatar are returned, never the email.',
  })
  @ApiOkResponse({ type: [UserSummaryDto] })
  search(@Query() query: UserSearchQueryDto): Promise<UserSummaryDto[]> {
    return this.users.search(query.q);
  }

  @Get(':id')
  @ApiOperation({ summary: "Another user's public profile (id, name, avatar)" })
  @ApiOkResponse({ type: UserSummaryDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  profile(@Param('id', ParseUuidPipe) id: string): Promise<UserSummaryDto> {
    return this.users.getProfile(id);
  }
}
