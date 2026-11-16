import type { Picture } from '@atlas/schema';

/**
 * Where the cards and photo guides show a photo of the pack from: a copy
 * smaller than its file, when there is one. A picture that names a copy
 * for pages (`pageCopy`) is shown from that copy. A photo to be fetched
 * later (`remote`) that names neither a copy shown (`shownAt`) nor a copy
 * for pages has a copy for cards that the desktop app makes when it keeps
 * the photo at full size: beside its file, named as a copy for pages is
 * (`pictures/m1.jpg` has `pictures/m1.page.jpg`, see `card_copy_path` in
 * the shell's `packfile`). That copy is there only when the photo was kept
 * wider than the cards show it, so a card falls back to the file when the
 * copy cannot be loaded; the larger view always shows the file.
 */
export function cardCopyFile(picture: Picture): string | undefined {
  if (picture.pageCopy) return picture.pageCopy.file;
  if (!picture.remote || picture.shownAt) return undefined;
  return copyName(picture.file);
}

/** `pictures/<stem>.page.<type>` for `pictures/<stem>.<type>`, when that is a picture's file name too. */
function copyName(file: string): string | undefined {
  const match = /^pictures\/([^/]+)\.([a-z]+)$/u.exec(file);
  if (!match) return undefined;
  const [, stem, type] = match as unknown as [string, string, string];
  // As long as a picture's file name may be (`is_picture_path` in the shell).
  const copyStem = `${stem}.page`;
  return copyStem.length <= 120 ? `pictures/${copyStem}.${type}` : undefined;
}
