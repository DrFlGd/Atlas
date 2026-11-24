import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

/**
 * The pictures inside a 3D map's model files, under the desktop app's own
 * content security policy (read from the shell's `tauri.conf.json`). The
 * model loader hands each picture held in a file to the browser as a
 * `blob:` address and reads it with `fetch`, which the policy's
 * `connect-src` governs: without `blob:` there, every texture fails to
 * load and the model is drawn white, though the view in a plain browser
 * shows it textured.
 */

const ORIGIN = 'http://atlas.test';

async function appPolicy(): Promise<string> {
  const config = JSON.parse(
    await readFile(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { security: { csp: Record<string, string> } } };
  return Object.entries(config.app.security.csp)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

test('a picture held in a model file loads under the app policy', async ({ page }) => {
  const policy = await appPolicy();
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'content-security-policy': policy },
      body: '<!doctype html><html><head><title>Model pictures</title></head><body></body></html>',
    }),
  );
  const refused: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) refused.push(message.text());
  });
  await page.goto(`${ORIGIN}/`);
  // A made-up 2 by 2 picture, as a model file holds it, read the way the model loader reads it.
  const size = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => {
        resolve(b!);
      }, 'image/png');
    });
    const address = URL.createObjectURL(blob);
    try {
      const answer = await fetch(address);
      const bitmap = await createImageBitmap(await answer.blob());
      return [bitmap.width, bitmap.height];
    } catch (error) {
      return String(error);
    } finally {
      URL.revokeObjectURL(address);
    }
  });
  expect(size).toEqual([2, 2]);
  expect(refused).toEqual([]);
});
