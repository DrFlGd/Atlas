import type { SiteLimits } from '@atlas/importer-api';

/**
 * The sentences that say why this app did not open an address on its own
 * for a site, from what the site's rules file says of such addresses
 * (`SiteInfo.keepOff` and `SiteInfo.permission`, see `fetching.ts` of the
 * importer contract). The same whether the app reads the site by itself or
 * in its window.
 */

/** Why the app did not open `address`: the site's rules file keeps it off that address. */
export const keptOffMessage = (address: string): string =>
  `The site's rules file keeps this app off ${address}, so it did not open that address and did not read the page.`;

/**
 * Why robots.txt stopped the reading of `address`, in a plain sentence:
 * with the permission the site's rules file records, when it does not
 * cover the address.
 */
export function robotsStopMessage(address: string, limits: SiteLimits): string {
  const permission = limits.permission;
  return permission
    ? `The site's robots.txt does not allow this app to read ${address}, and the permission from ${permission.from} recorded in the site's rules file does not cover that address, so it stopped and read no more pages.`
    : `The site's robots.txt does not allow this app to read ${address}, so it stopped and read no more pages.`;
}
