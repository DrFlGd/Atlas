# Atlas's Steam artwork

Pictures for Atlas as a non-Steam game in Steam. Atlas copies them into Steam itself (**Settings**, then **Atlas in Steam**, then **Add Atlas to Steam**). The release also has them as `Atlas-Steam-artwork.zip`, with this file, for setting them by hand.

| File                             | In Steam                                              | Size        |
| -------------------------------- | ----------------------------------------------------- | ----------- |
| `atlas-steam-grid-600x900.jpg`   | Grid (the portrait cover in the library)              | 600 × 900   |
| `atlas-steam-wide-920x430.jpg`   | Wide capsule (recent games, Big Picture)              | 920 × 430   |
| `atlas-steam-hero-3840x1240.jpg` | Hero (the wide picture at the top of the game's page) | 3840 × 1240 |
| `atlas-steam-logo-1280x720.png`  | Logo (laid over the hero, transparent)                | 1280 × 720  |
| `atlas-steam-icon-512.png`       | Icon                                                  | 512 × 512   |

## Setting them by hand

1. Add Atlas to Steam: in Steam's **Games** menu, choose **Add a Non-Steam Game to My Library**, and choose Atlas (on Windows the Atlas program in the folder Atlas is installed in, on Linux and the Steam Deck `Atlas.AppImage`).
2. In the library, right-click Atlas and choose **Manage**, then **Set custom artwork**. Choose the Grid picture. Do the same on the wide capsule in **Recent games** for the Wide picture.
3. Open Atlas's page in the library. Right-click the empty area at the top and choose **Set custom background** for the Hero picture, and **Set custom logo** for the Logo.
4. For the icon, right-click Atlas, choose **Properties**, and press the square beside its name to choose the Icon picture.

## Making them again

`make-steam-art.mjs` draws every picture as SVG and saves it with a headless Chromium: the grid, wide and hero pictures as JPEG (quality 90), the logo and icon as PNG with transparency. From the repository's root, after `pnpm install` and `pnpm --filter @atlas/web exec playwright install chromium`:

```sh
node apps/desktop/steam-art/make-steam-art.mjs apps/desktop/steam-art
```

It writes the SVG of each picture beside it as well (not kept in the repository). The art is original: Atlas's folded-map mark and colours, with made-up contour lines, a route and pins; nothing from a real game or map site.

## Font

The word ATLAS and the line under it are set in **Inter Display** and **Inter** by Rasmus Andersson, under the [SIL Open Font License 1.1](https://openfontlicense.org). The fonts must be installed on the computer that makes the pictures; the pictures hold only the drawn letters, not the font files.

The pictures are under the repository's MIT licence.
