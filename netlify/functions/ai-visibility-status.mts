import type { Config } from '@netlify/functions';
import { fulfillOrder, signDownload, verifiedOrder } from './_shared/ai-visibility.mts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async (request: Request) => {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  try {
    const sessionId = new URL(request.url).searchParams.get('session_id') || '';
    const order = await verifiedOrder(sessionId);
    if (!order.offer || !order.paid) return json({ paid: false, processing: order.session.payment_status === 'unpaid' }, 402);
    await fulfillOrder(order.session, order.offer);
    return json({ paid: true, offer: order.offer.slug, offerName: order.offer.name, files: order.offer.files.map((file) => ({ file, url: `/api/ai-visibility-download?token=${encodeURIComponent(signDownload(order.session.id, file))}` })), onboardingUrl: order.offer.slug === 'management' ? `/ai-visibility/onboarding?session_id=${encodeURIComponent(order.session.id)}` : null });
  } catch { return json({ paid: false, error: 'Order could not be verified.' }, 400); }
};
export const config: Config = { path: '/api/ai-visibility-status' };
