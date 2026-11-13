import { describe, expect, it } from 'vitest';
import { parseInline, writeInline } from './inline';
import { inlineSize, readPictureSize, widthSize, writePictureSize } from './pictureSize';

describe('the size a page shows a picture at', () => {
  it('is read from the picture’s title, and written back as it was', () => {
    for (const title of [undefined, '=28x13', '=28', '=300x200', 'At dawn']) {
      expect(writePictureSize(readPictureSize(title))).toBe(title);
    }
    expect(readPictureSize('=28x13')).toEqual({ kind: 'inline', width: 28, height: 13 });
    expect(readPictureSize('=300x200')).toEqual({ kind: 'width', width: 300, height: 200 });
    expect(readPictureSize('At dawn')).toEqual({ kind: 'other', title: 'At dawn' });
  });

  it('is put in the line of text with its shape kept, or given as a width', () => {
    expect(inlineSize(640, 320)).toEqual({ kind: 'inline', width: 40, height: 20 });
    expect(inlineSize()).toEqual({ kind: 'inline', width: 20, height: 20 });
    expect(widthSize(' 240 ')).toEqual({ kind: 'width', width: 240 });
    expect(widthSize('0')).toBeNull();
    expect(widthSize('wide')).toBeNull();
  });

  it('is kept exactly when the text around the picture is edited', () => {
    const pieces = parseInline('A ![gate](demo:picture:gate "=28x13") here');
    pieces.push({ kind: 'text', text: ' and more', marks: {} });
    expect(writeInline(pieces)).toBe('A ![gate](demo:picture:gate "=28x13") here and more');
  });
});
