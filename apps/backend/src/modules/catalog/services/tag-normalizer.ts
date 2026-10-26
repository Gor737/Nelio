import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { isValidText } from '../../../common/decorators/text-length.decorator.js';

export interface NormalizedTag {
  /** The stored name: normalized and lowercase, e.g. `web development`. */
  readonly name: string;
  /** The unique key: the name with single hyphens instead of spaces, e.g. `web-development`. */
  readonly slug: string;
}

export type TagNormalization =
  | { readonly ok: true; readonly tag: NormalizedTag }
  | { readonly ok: false; readonly problem: string };

/**
 * Invisible format characters, listed by code point (so this file never contains an invisible character itself): zero-width space,
 * zero-width non-joiner, zero-width joiner, word joiner, byte-order mark and soft hyphen. They are removed, so `a` + U+200B + `b` and
 * `ab` cannot become two different tags.
 */
const INVISIBLE_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_CODE_POINTS.map((code) => String.fromCodePoint(code)).join('')}]`,
  'gu',
);
const CONTROL = /\p{Cc}/gu;

/**
 * Armenian ligature letters that compatibility normalization (NFKC) would SPLIT into two letters: `և` (U+0587, a standard letter of
 * Armenian orthography, "and") would become `եւ`, which changes how a word is spelled. They are kept as they are. The other U+FB13-FB17
 * Armenian presentation forms are listed for the same reason. Everything else is folded with NFKC.
 */
const KEEP_AS_IS = new Set([0x0587, 0xfb13, 0xfb14, 0xfb15, 0xfb16, 0xfb17]);

/**
 * NFC first (joins `e` + combining accent), then NFKC for each code point except the protected Armenian letters (full-width Latin,
 * ligatures such as the `fi` ligature and other compatibility forms become their plain equivalents), then NFC again.
 */
function canonicalForm(text: string): string {
  const composed = text.normalize('NFC');
  let folded = '';
  for (const char of composed)
    folded += KEEP_AS_IS.has(char.codePointAt(0) ?? -1)
      ? char
      : char.normalize('NFKC');
  return folded.normalize('NFC');
}

/**
 * Tag hygiene (Decisions 44 and 62: "normalization, caps and Admin merge"). Free-form tag input becomes a canonical tag so that
 * `JavaScript`, ` javascript ` and `JAVASCRIPT` are one tag:
 *   1. Unicode normalization (full-width letters, ligatures and compatibility forms become their plain equivalents, composed accents are
 *      joined; the Armenian letter `և` is kept as it is: see `canonicalForm`);
 *   2. invisible and control characters are removed, runs of whitespace become one space, the ends are trimmed;
 *   3. lowercase (Unicode default case mapping: Armenian `Բարև` becomes `բարև`);
 *   4. the result must be 2-30 characters (`TEXT_LIMITS.TAG_NAME`, counted in code points) AFTER all of the above, must contain
 *      at least one letter or digit (so `!!!` and a row of emoji are not tags), and must be valid text.
 * The slug is the name with spaces turned into single hyphens; two spellings with the same slug are the same tag.
 *
 * These rules were chosen by the implementer where the documents are silent and are listed in docs/proposed-defaults.md (section 13).
 */
export function normalizeTag(raw: unknown): TagNormalization {
  if (typeof raw !== 'string')
    return { ok: false, problem: 'must be a string' };
  const name = canonicalForm(raw)
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  if (!isValidText(name, TEXT_LIMITS.TAG_NAME)) {
    return {
      ok: false,
      problem: `must be between ${TEXT_LIMITS.TAG_NAME.min} and ${TEXT_LIMITS.TAG_NAME.max} characters after cleaning`,
    };
  }
  if (!/[\p{L}\p{N}]/u.test(name))
    return { ok: false, problem: 'must contain at least one letter or digit' };
  return {
    ok: true,
    tag: { name, slug: name.replace(/ /g, '-').replace(/-{2,}/g, '-') },
  };
}

/** The same canonical form for a search prefix: it may be a single character, and it may end in a space or hyphen being typed. */
export function normalizeTagPrefix(raw: string): string {
  return canonicalForm(raw)
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/gu, ' ')
    .trimStart()
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/-{2,}/g, '-');
}
