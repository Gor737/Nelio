// A throwaway endpoint shaped like registration / forgot-password: it sends an email and then answers 202 whatever happened
// (those endpoints must not reveal whether an address exists, and must not fail because a mail server does). Test code only.
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { Public } from '../../src/common/decorators/index.js';
import {
  MailModule,
  MailService,
} from '../../src/infrastructure/mail/index.js';

export class ProbeMailDto {
  @IsEmail()
  email!: string;
}

@Public()
@Controller('probe-mail')
export class ProbeMailController {
  constructor(private readonly mail: MailService) {}

  @Post('register')
  @HttpCode(202)
  async register(@Body() dto: ProbeMailDto) {
    // In the real flow this runs AFTER the transaction commits, and the result is ignored.
    await this.mail.sendEmailVerification(dto.email, {
      fullName: 'Probe User',
      token: 'probe-token',
      validForHours: 24,
    });
    return {};
  }
}

@Module({ imports: [MailModule], controllers: [ProbeMailController] })
export class ProbeMailModule {}
