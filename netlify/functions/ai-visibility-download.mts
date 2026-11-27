import type { Config } from '@netlify/functions';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { verifiedOrder, verifyDownload } from './_shared/ai-visibility.mts';

const files = {
  playbook: { name: 'Ninth-and-Oak-AI-Visibility-Playbook.pdf', type: 'application/pdf' },
  toolkit: { name: 'Ninth-and-Oak-Business-Toolkit.zip', type: 'application/zip' },
} as const;

export default async (request: Request) => {
  try {
    const token = new URL(request.url).searchParams.get('token') || '';
    const value = verifyDownload(token);
    if (!value || !(value.f in files)) return new Response('Invalid or expired download.', { status: 401 });
    const order = await verifiedOrder(value.s);
    if (!order.offer || !order.paid || !order.offer.files.includes(value.f as never)) return new Response('Purchase required.', { status: 403 });
    const file = files[value.f as keyof typeof files];
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../private-assets', file.name);
    const body = await readFile(path);
    return new Response(body, { headers: { 'content-type': file.type, 'content-disposition': `attachment; filename="${file.name}"`, 'cache-control': 'private, no-store' } });
  } catch { return new Response('Download unavailable.', { status: 400 }); }
};
export const config: Config = { path: '/api/ai-visibility-download' };
