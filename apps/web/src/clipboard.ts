/**
 * Puts text on the clipboard: through the Clipboard API, or else by
 * selecting it in a hidden text area and copying, for webviews without the
 * API. Inside a modal dialog, pass the dialog as `host`, since the rest of
 * the page cannot take focus then.
 */
export async function copyText(text: string, host: HTMLElement = document.body): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    host.append(area);
    area.select();
    let copied: boolean;
    try {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}
