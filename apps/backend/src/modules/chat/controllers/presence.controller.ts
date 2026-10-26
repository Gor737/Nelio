import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { PresenceDto } from '../dto/chat.dto.js';
import { PresenceService } from '../services/presence.service.js';

@ApiTags('Chat')
@ApiBearerAuth('access-token')
@Controller('me/presence')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  @ApiOperation({
    summary: 'Who is online now',
    description:
      'The initial state for presence: people you share a direct conversation or a group with who are online. Updates arrive as the socket event `presence:update` after `presence:subscribe`. People with a block with you, suspended accounts and course-channel peers are never listed. "Last seen" is not exposed anywhere.',
  })
  @ApiOkResponse({ type: PresenceDto })
  async online(@CurrentUser() user: AuthenticatedUser): Promise<PresenceDto> {
    return { online: await this.presence.onlinePeers(user.id) };
  }
}
