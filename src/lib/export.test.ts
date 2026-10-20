import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from './export';

describe('portable export filenames', () => {
  it.each(['CON', 'con.txt', 'PRN', 'AUX.png', 'NUL', 'COM1', 'LPT9', 'COM¹'])(
    'escapes the Windows reserved name %s',
    (name) => {
      expect(sanitizeFilename(name)).toBe(`_${name}`);
    },
  );

  it('removes path traversal, forbidden characters and trailing spaces or dots', () => {
    expect(sanitizeFilename('../a\\b:c*?"<>|. ')).toBe('_a_b_c______');
    expect(sanitizeFilename('\u0000abc\u001f')).toBe('_abc_');
    expect(sanitizeFilename(' . . ')).toBe('素材');
    expect(sanitizeFilename('')).toBe('素材');
    expect(sanitizeFilename('中文名字')).toBe('中文名字');
    expect(sanitizeFilename('x'.repeat(400)).length).toBeLessThanOrEqual(121);
  });

  it('does not split a surrogate pair when truncating a long name', () => {
    expect(sanitizeFilename(`${'a'.repeat(119)}😀`)).toBe('a'.repeat(119));
  });
});
