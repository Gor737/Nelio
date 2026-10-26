/**
 * Video blocks are an external URL only (Decision 17), from YouTube or Vimeo only. The URL is parsed ONCE, when the block is saved:
 * only `provider` and `externalId` are stored, the id is checked against the provider's own pattern, and the embed URL is built here,
 * on the server, from those two values alone. Nothing the user typed (host, path, query, fragment) ever reaches a page or an iframe.
 */
export const VIDEO_PROVIDERS = ['YOUTUBE', 'VIMEO'] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

export interface ParsedVideo {
  readonly provider: VideoProvider;
  readonly externalId: string;
}

export const MAX_VIDEO_URL_LENGTH = 300;

/** YouTube ids are exactly 11 characters of `A-Z a-z 0-9 _ -`; Vimeo ids are decimal numbers. */
const ID_PATTERNS: Record<VideoProvider, RegExp> = {
  YOUTUBE: /^[A-Za-z0-9_-]{11}$/,
  VIMEO: /^[1-9][0-9]{0,11}$/,
};
/** The optional privacy hash of an unlisted Vimeo link (`vimeo.com/<id>/<hash>`); accepted in the shape, never stored. */
const VIMEO_HASH = /^[0-9a-f]{6,16}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

export const isValidVideoId = (provider: VideoProvider, id: string): boolean =>
  ID_PATTERNS[provider].test(id);

/** The URL of the embedded player, from provider and id only. Throws on an id that does not match the provider's pattern. */
export function buildEmbedUrl(
  provider: VideoProvider,
  externalId: string,
): string {
  if (!isValidVideoId(provider, externalId))
    throw new TypeError('buildEmbedUrl: invalid video id');
  return provider === 'YOUTUBE'
    ? `https://www.youtube-nocookie.com/embed/${externalId}`
    : `https://player.vimeo.com/video/${externalId}`;
}

/** Returns the provider and id of a YouTube or Vimeo link, or null for anything else (other hosts, hostile or malformed input). */
export function parseVideoUrl(input: string): ParsedVideo | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_VIDEO_URL_LENGTH) return null;
  // no whitespace or control characters anywhere inside the link
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '')
    return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter((s) => s.length > 0);

  if (host === 'youtu.be') {
    return segments.length === 1 ? youtube(segments[0]) : null;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === 'watch')
      return youtube(url.searchParams.get('v') ?? '');
    if (
      segments.length === 2 &&
      ['embed', 'shorts', 'live', 'v'].includes(segments[0])
    )
      return youtube(segments[1]);
    return null;
  }
  if (VIMEO_HOSTS.has(host)) {
    const player = host === 'player.vimeo.com';
    if (player) {
      return segments.length === 2 && segments[0] === 'video'
        ? vimeo(segments[1])
        : null;
    }
    if (segments.length === 1) return vimeo(segments[0]);
    if (segments.length === 2 && VIMEO_HASH.test(segments[1]))
      return vimeo(segments[0]);
    return null;
  }
  return null;
}

function youtube(id: string): ParsedVideo | null {
  return isValidVideoId('YOUTUBE', id)
    ? { provider: 'YOUTUBE', externalId: id }
    : null;
}

function vimeo(id: string): ParsedVideo | null {
  return isValidVideoId('VIMEO', id)
    ? { provider: 'VIMEO', externalId: id }
    : null;
}
