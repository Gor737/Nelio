/**
 * The three transactional emails of the authentication flow (docs/architecture.md section 11): verify the address, reset the
 * password, and "already registered". Pure functions: given the data, return the subject and both bodies, so they are easy to
 * test and cannot fail on I/O.
 *
 * Wording and page names are proposed defaults (docs/proposed-defaults.md, section 12): English text, and the frontend pages
 * `/verify-email`, `/reset-password`, `/login` and `/forgot-password` under FRONTEND_ORIGIN. The token travels only in the link's
 * query string; the frontend page reads it and POSTs it, so opening the link never changes anything by itself (email-token
 * rule: "consumed by POST only").
 */
export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const PRODUCT = 'Nelio';

/** Escapes text for an HTML body and for an HTML attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** `https://app.example.com` + `/verify-email` + token -> a link whose token is URL-encoded. */
export function frontendLink(
  origin: string,
  path: string,
  token?: string,
): string {
  const url = new URL(path, `${origin.replace(/\/$/, '')}/`);
  if (token !== undefined) url.searchParams.set('token', token);
  return url.toString();
}

/** A greeting that works for any name, including right-to-left and Armenian text; control characters are removed. */
function greetingName(fullName: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = fullName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 100) : 'there';
}

function layout(
  heading: string,
  paragraphs: string[],
  action?: { label: string; url: string },
): string {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px">${p}</p>`)
    .join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p><p style="margin:0 0 16px;font-size:13px;color:#555555">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(action.url)}">${escapeHtml(action.url)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111111"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${button}<p style="margin:24px 0 0;font-size:13px;color:#555555">${PRODUCT}</p></body></html>`;
}

export function emailVerification(input: {
  fullName: string;
  url: string;
  validForHours: number;
}): RenderedEmail {
  const name = greetingName(input.fullName);
  const validity = `This link works for ${input.validForHours} hours and can be used once.`;
  return {
    subject: `Confirm your email address for ${PRODUCT}`,
    text: [
      `Hi ${name},`,
      '',
      `Confirm your email address to finish creating your ${PRODUCT} account:`,
      input.url,
      '',
      validity,
      `If you did not create a ${PRODUCT} account, you can ignore this email.`,
    ].join('\n'),
    html: layout(
      'Confirm your email address',
      [
        `Hi ${escapeHtml(name)},`,
        `Confirm your email address to finish creating your ${PRODUCT} account.`,
        escapeHtml(validity),
        `If you did not create a ${PRODUCT} account, you can ignore this email.`,
      ],
      { label: 'Confirm email address', url: input.url },
    ),
  };
}

export function passwordReset(input: {
  fullName: string;
  url: string;
  validForHours: number;
}): RenderedEmail {
  const name = greetingName(input.fullName);
  const validity = `This link works for ${input.validForHours} ${input.validForHours === 1 ? 'hour' : 'hours'} and can be used once.`;
  return {
    subject: `Reset your ${PRODUCT} password`,
    text: [
      `Hi ${name},`,
      '',
      `We received a request to reset the password of your ${PRODUCT} account. Choose a new password here:`,
      input.url,
      '',
      validity,
      'If you did not ask for this, you can ignore this email: your password stays as it is.',
    ].join('\n'),
    html: layout(
      'Reset your password',
      [
        `Hi ${escapeHtml(name)},`,
        `We received a request to reset the password of your ${PRODUCT} account.`,
        escapeHtml(validity),
        'If you did not ask for this, you can ignore this email: your password stays as it is.',
      ],
      { label: 'Choose a new password', url: input.url },
    ),
  };
}

/**
 * Sent when someone registers with an address that already has a verified account. The registration endpoint always answers
 * 202, so this email is the only way the owner of the address learns that the account exists; nothing in it can be used to
 * take the account over.
 */
export function alreadyRegistered(input: {
  fullName: string;
  loginUrl: string;
  forgotPasswordUrl: string;
}): RenderedEmail {
  const name = greetingName(input.fullName);
  return {
    subject: `You already have a ${PRODUCT} account`,
    text: [
      `Hi ${name},`,
      '',
      `Someone tried to create a ${PRODUCT} account with this email address, but an account already exists.`,
      `Log in: ${input.loginUrl}`,
      `Forgot your password? ${input.forgotPasswordUrl}`,
      '',
      'If this was not you, you can ignore this email: nothing has changed.',
    ].join('\n'),
    html: layout(
      'You already have an account',
      [
        `Hi ${escapeHtml(name)},`,
        `Someone tried to create a ${PRODUCT} account with this email address, but an account already exists.`,
        `Forgot your password? <a href="${escapeHtml(input.forgotPasswordUrl)}">Reset it here</a>.`,
        'If this was not you, you can ignore this email: nothing has changed.',
      ],
      { label: 'Log in', url: input.loginUrl },
    ),
  };
}
