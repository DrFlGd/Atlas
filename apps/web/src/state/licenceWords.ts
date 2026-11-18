/**
 * The words of the licence question, as the importer's licence step and
 * the settings of a site rules file both say them: the types of answer, in
 * the order shown, each with its sentence.
 */

/** The types of answer to the licence question, in the order shown. */
export type LicenceType = 'known' | 'permission' | 'none';

export const LICENCE_TYPES: readonly LicenceType[] = ['known', 'permission', 'none'];

export const LICENCE_TYPE_LABELS: Record<LicenceType, string> = {
  known: 'A known licence',
  permission: 'Fill in',
  none: 'Blank',
};

export const LICENCE_TYPE_TEXTS: Record<LicenceType, string> = {
  known:
    'A Creative Commons licence. Choose one only if the wiki says so itself, on a page about its copyright or in its terms.',
  permission:
    'What you have instead, such as permission from the site’s owner. The pages are kept for your own use.',
  none: 'Nothing is recorded about permission, and the pages are kept for your own use.',
};

/** The fields of a licence filled in, as the licence step labels them. */
export const LICENCE_FIELD_LABELS = {
  words: 'What to show under each page',
  givenBy: 'Who gave it (optional)',
  givenOn: 'Date (optional)',
  terms: 'Address where the terms can be read (optional)',
  note: 'Note (optional)',
} as const;
