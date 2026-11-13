import { createContext } from 'react';
import type { ShownPicture } from '../../markdownEdit/dom';

/** How a picture of the page is shown while it is edited. */
export const PictureContext = createContext<(src: string) => ShownPicture | null>(() => null);
