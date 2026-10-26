import { describe, expect, it } from '@jest/globals';
import { COURSE_RELATIONSHIPS } from '../../../src/common/constants/permission-matrix.js';
import {
  MAX_VIDEO_URL_LENGTH,
  buildEmbedUrl,
  isValidVideoId,
  parseVideoUrl,
} from '../../../src/modules/content/services/video-url.js';
import {
  isTeacherRelationship,
  visibleLessonWhere,
} from '../../../src/modules/content/visible-lessons.js';

const YT = 'dQw4w9WgXcQ';

describe('parseVideoUrl: accepted links', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT}`],
    [`https://youtube.com/watch?v=${YT}&t=42s&list=PL123`],
    [`https://m.youtube.com/watch?v=${YT}`],
    [`http://www.youtube.com/watch?v=${YT}`],
    [`https://youtu.be/${YT}`],
    [`https://youtu.be/${YT}?si=abc`],
    [`https://www.youtube.com/embed/${YT}`],
    [`https://www.youtube-nocookie.com/embed/${YT}`],
    [`https://www.youtube.com/shorts/${YT}`],
    [`https://www.youtube.com/live/${YT}`],
    [`  https://WWW.YouTube.com/watch?v=${YT}  `],
    [`https://www.youtube.com/watch?v=${YT}#fragment`],
  ])('YouTube: %s', (url) => {
    expect(parseVideoUrl(url)).toEqual({ provider: 'YOUTUBE', externalId: YT });
  });

  it.each([
    ['https://vimeo.com/76979871'],
    ['https://www.vimeo.com/76979871'],
    ['https://player.vimeo.com/video/76979871'],
    ['https://vimeo.com/76979871/abcdef123456'],
    ['https://vimeo.com/76979871?share=copy'],
  ])('Vimeo: %s', (url) => {
    expect(parseVideoUrl(url)).toEqual({
      provider: 'VIMEO',
      externalId: '76979871',
    });
  });
});

describe('parseVideoUrl: rejected input', () => {
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['plain text', 'not a link'],
    ['a bare id', YT],
    ['javascript scheme', `javascript:alert(1)//youtube.com/watch?v=${YT}`],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['ftp scheme', `ftp://youtube.com/watch?v=${YT}`],
    ['file scheme', 'file:///etc/passwd'],
    ['another host', `https://evil.example/watch?v=${YT}`],
    [
      'host that merely contains youtube.com',
      `https://youtube.com.evil.example/watch?v=${YT}`,
    ],
    ['host that ends like youtube.com', `https://notyoutube.com/watch?v=${YT}`],
    [
      'youtube as a user name',
      `https://youtube.com@evil.example/watch?v=${YT}`,
    ],
    [
      'user info on the real host',
      `https://user:pass@www.youtube.com/watch?v=${YT}`,
    ],
    ['a port', `https://www.youtube.com:8443/watch?v=${YT}`],
    ['other video sites', 'https://www.dailymotion.com/video/x7tgad0'],
    ['tiktok', 'https://www.tiktok.com/@a/video/7000000000000000000'],
    ['no id', 'https://www.youtube.com/watch'],
    ['empty id', 'https://www.youtube.com/watch?v='],
    ['channel page', 'https://www.youtube.com/@somebody'],
    ['playlist page', 'https://www.youtube.com/playlist?list=PL123'],
    ['too short id', 'https://www.youtube.com/watch?v=abc'],
    ['too long id', `https://www.youtube.com/watch?v=${YT}X`],
    ['id with a quote', `https://www.youtube.com/watch?v=${YT.slice(0, 10)}"`],
    [
      'id with an apostrophe',
      `https://www.youtube.com/watch?v=${YT.slice(0, 10)}'`,
    ],
    [
      'id with an angle bracket',
      `https://www.youtube.com/watch?v=${YT.slice(0, 10)}<`,
    ],
    [
      'id with a slash',
      `https://www.youtube.com/embed/${YT.slice(0, 5)}/${YT.slice(0, 4)}`,
    ],
    ['id with a dot', `https://www.youtube.com/watch?v=${YT.slice(0, 10)}.`],
    ['extra path after the id', `https://www.youtube.com/embed/${YT}/extra`],
    ['whitespace inside', `https://www.youtube.com/watch?v=${YT} x`],
    [
      'a newline inside',
      `https://www.youtube.com/watch?v=${YT}\nhttps://evil.example`,
    ],
    [
      'a tab inside',
      `https://www.youtube.com/watch?v=${YT}\t`.replace(/\t$/, '\tx'),
    ],
    ['a NUL inside', `https://www.youtube.com/watch?v=${YT}\u0000`],
    ['youtu.be with a path', `https://youtu.be/embed/${YT}`],
    ['vimeo without an id', 'https://vimeo.com/'],
    ['vimeo non-numeric id', 'https://vimeo.com/abcdefgh'],
    ['vimeo zero id', 'https://vimeo.com/0'],
    ['vimeo leading zero', 'https://vimeo.com/012345'],
    ['vimeo 13 digits', 'https://vimeo.com/1234567890123'],
    ['vimeo hostile id', 'https://vimeo.com/123"onload="x'],
    ['vimeo bad hash', 'https://vimeo.com/76979871/not-a-hash!'],
    ['vimeo channel', 'https://vimeo.com/channels/staffpicks/76979871'],
    ['player without /video/', 'https://player.vimeo.com/76979871'],
    ['vimeo lookalike', 'https://vimeo.com.evil.example/76979871'],
    [
      'over-long input',
      `https://www.youtube.com/watch?v=${YT}&x=${'a'.repeat(MAX_VIDEO_URL_LENGTH)}`,
    ],
  ])('%s', (_name, url) => {
    expect(parseVideoUrl(url)).toBeNull();
  });

  it('a non-string is rejected', () => {
    expect(parseVideoUrl(undefined as unknown as string)).toBeNull();
    expect(parseVideoUrl(42 as unknown as string)).toBeNull();
  });
});

describe('ids and embed URLs', () => {
  it('the embed URL is built from provider and id only', () => {
    expect(buildEmbedUrl('YOUTUBE', YT)).toBe(
      `https://www.youtube-nocookie.com/embed/${YT}`,
    );
    expect(buildEmbedUrl('VIMEO', '76979871')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
  });

  it.each([
    ['YOUTUBE', `${YT}"onload="x`],
    ['YOUTUBE', `../${YT}`],
    ['YOUTUBE', `${YT} `],
    ['YOUTUBE', 'a'.repeat(65)],
    ['YOUTUBE', ''],
    ['VIMEO', 'javascript:alert(1)'],
    ['VIMEO', '123/../456'],
    ['VIMEO', '12 3'],
    ['VIMEO', '1'.repeat(65)],
  ] as const)('a hostile or malformed %s id is refused: %j', (provider, id) => {
    expect(isValidVideoId(provider, id)).toBe(false);
    expect(() => buildEmbedUrl(provider, id)).toThrow(TypeError);
  });

  it('a YouTube id is not a Vimeo id and the other way round', () => {
    expect(isValidVideoId('VIMEO', YT)).toBe(false);
    expect(isValidVideoId('YOUTUBE', '76979871')).toBe(false);
  });
});

describe('visibleLessonWhere (the single visibility definition)', () => {
  const text = (
    relationship: (typeof COURSE_RELATIONSHIPS)[number],
    alias?: string,
  ) => visibleLessonWhere(relationship, alias).sql.replace(/\s+/g, ' ').trim();

  it('teachers see everything, an ACTIVE student sees published lessons, everybody else sees nothing', () => {
    expect(text('OWNER')).toBe('TRUE');
    expect(text('ASSISTANT')).toBe('TRUE');
    expect(text('STUDENT_ACTIVE')).toBe("l.status = 'PUBLISHED'");
    for (const relationship of COURSE_RELATIONSHIPS.filter(
      (r) => !['OWNER', 'ASSISTANT', 'STUDENT_ACTIVE'].includes(r),
    ))
      expect(text(relationship)).toBe('FALSE');
  });

  it('uses the alias it is given and refuses an alias that could carry SQL', () => {
    expect(text('STUDENT_ACTIVE', 'les')).toBe("les.status = 'PUBLISHED'");
    for (const alias of ['l; DROP TABLE users', 'l.x', '', '1l', 'L', "l'"])
      expect(() => visibleLessonWhere('STUDENT_ACTIVE', alias)).toThrow(
        TypeError,
      );
  });

  it('isTeacherRelationship is true only for the Owner and Assistants', () => {
    expect(COURSE_RELATIONSHIPS.filter(isTeacherRelationship)).toEqual([
      'OWNER',
      'ASSISTANT',
    ]);
  });
});
