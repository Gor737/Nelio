import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  CurrentUser,
  Public,
  RateLimit,
} from '../../../common/decorators/index.js';
import {
  ApiException,
  ErrorResponseDto,
} from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../infrastructure/config/index.js';
import {
  assertFrontendOrigin,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from '../auth-cookie.js';
import {
  AcceptedDto,
  AuthTokensDto,
  ChangePasswordDto,
  EmailOnlyDto,
  GoogleDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  TokenDto,
} from '../dto/auth.dto.js';
import { AuthService, type SessionTokens } from '../services/auth.service.js';
import { GoogleAuthService } from '../services/google-auth.service.js';

const ACCEPTED: AcceptedDto = {
  message: 'If this can be done, an email is on its way',
};

/**
 * Authentication endpoints (Decision 148). `register`, `resend-verification` and `forgot-password` always answer 202 with the same body,
 * so they never reveal whether an address is registered. Email tokens are consumed by POST only. `login` and `google` return the access
 * token in the body and the refresh token as an HttpOnly cookie; the frontend then calls `GET /me`.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('register')
  @Public()
  @HttpCode(202)
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'Register with email and password',
    description:
      'Always 202 with the same body. A new address gets a verification email; an unverified one has its password replaced and gets a new link; a verified one gets an "already registered" email. Verification never logs in. The body cannot choose a role (any unknown property is 400).',
  })
  @ApiAcceptedResponse({ type: AcceptedDto })
  async register(@Body() dto: RegisterDto): Promise<AcceptedDto> {
    await this.auth.register(dto);
    return ACCEPTED;
  }

  @Post('verify-email')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Verify an email address with the token from the email',
    description:
      '400 TOKEN_INVALID when the token is unknown, used or expired. Does not log in.',
  })
  @ApiNoContentResponse()
  async verifyEmail(@Body() dto: TokenDto): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @Public()
  @HttpCode(202)
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'Send a new verification email',
    description: 'Always 202; at most one email a minute per address.',
  })
  @ApiAcceptedResponse({ type: AcceptedDto })
  async resend(@Body() dto: EmailOnlyDto): Promise<AcceptedDto> {
    await this.auth.resendVerification(dto.email);
    return ACCEPTED;
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'Log in with email and password',
    description:
      'An unknown email, a wrong password and an account that only has Google all give the same 401. A suspended account is 403 ACCOUNT_SUSPENDED and an unverified email 403 FORBIDDEN (only after a correct password). Throttled before any hashing.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensDto> {
    return this.respond(res, await this.auth.login(dto.email, dto.password));
  }

  @Post('google')
  @Public()
  @HttpCode(200)
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'Sign in with a Google ID token',
    description:
      'The four sign-in rules of Decision 59. 503 when Google sign-in is not configured; 401 for a token that cannot be verified or whose email Google did not verify.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  async googleSignIn(
    @Body() dto: GoogleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensDto> {
    return this.respond(res, await this.google.signIn(dto.idToken));
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get a new access token with the refresh cookie',
    description:
      'Rotates the refresh token (a new cookie is set). 401 for a missing, unknown, expired or revoked token; a token used again after the ~10 second grace window revokes the whole session family (401). Inside the grace window the second of two parallel refreshes is 409 and nothing is revoked. The Origin header, when present, must be the frontend origin (403).',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensDto> {
    assertFrontendOrigin(req, this.config.frontendOrigin);
    const cookie = readRefreshCookie(req);
    if (!cookie) {
      clearRefreshCookie(res);
      throw new ApiException('UNAUTHENTICATED');
    }
    try {
      return this.respond(res, await this.auth.refresh(cookie));
    } catch (error) {
      if (!(error instanceof ApiException && error.status === 409))
        clearRefreshCookie(res); // the session is gone (or must be): do not keep sending the dead cookie
      throw error;
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Log out this device',
    description:
      'Revokes the session family of the refresh cookie and clears it. Always 204. The Origin header, when present, must be the frontend origin.',
  })
  @ApiNoContentResponse()
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    assertFrontendOrigin(req, this.config.frontendOrigin);
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
  }

  @Post('logout-all')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Log out every device',
    description:
      'Revokes every refresh token and every access token issued so far; open sockets are closed.',
  })
  @ApiNoContentResponse()
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutAll(user.id);
    clearRefreshCookie(res);
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(202)
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'Email a password-reset link',
    description: 'Always 202. Also how a Google-only account adds a password.',
  })
  @ApiAcceptedResponse({ type: AcceptedDto })
  async forgot(@Body() dto: EmailOnlyDto): Promise<AcceptedDto> {
    await this.auth.forgotPassword(dto.email);
    return ACCEPTED;
  }

  @Post('reset-password')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Set a new password with the token from the email',
    description:
      'Verifies the email, revokes every session of the user and every older reset link. 400 TOKEN_INVALID for a bad token (checked before the password is hashed).',
  })
  @ApiNoContentResponse()
  async reset(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change my password',
    description:
      '403 INVALID_CURRENT_PASSWORD for a wrong current password. Signs the OTHER devices out and keeps this one; returns a fresh access token (the old one stops working).',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async change(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<AuthTokensDto> {
    return this.auth.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
      readRefreshCookie(req),
    );
  }

  @Post('google/link')
  @HttpCode(204)
  @RateLimit('STRICT')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Add a Google login to my account',
    description:
      '409 when this Google account (or this user) already has a Google login.',
  })
  @ApiNoContentResponse()
  async link(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GoogleDto,
  ): Promise<void> {
    await this.google.link(user.id, dto.idToken);
  }

  @Delete('google')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Remove the Google login',
    description:
      '409 NO_LOGIN_METHOD_REMAINING when the account has no password.',
  })
  @ApiNoContentResponse()
  async unlink(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.google.unlink(user.id);
  }

  private respond(res: Response, session: SessionTokens): AuthTokensDto {
    setRefreshCookie(res, session.refresh.raw, session.refresh.expiresAt);
    return session.access;
  }
}
