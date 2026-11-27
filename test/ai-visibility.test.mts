import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFERS, signDownload, verifiedOrder, verifyDownload } from '../netlify/functions/_shared/ai-visibility.mts';

process.env.DOWNLOAD_SIGNING_SECRET = 'test-signing-secret-that-is-long-enough';

const session = (priceId: string, paymentStatus = 'paid', amount = 2700) => ({
  id: 'cs_test_valid123', payment_status: paymentStatus, amount_total: amount, currency: 'usd',
  line_items: { data: [{ price: { id: priceId } }] },
});
const stripe = (value: unknown) => ({ checkout: { sessions: { retrieve: async () => value } } }) as any;

test('recognizes only the approved paid Playbook price and amount', async () => {
  const order = await verifiedOrder('cs_test_valid123', stripe(session('price_1UgVjLLmNyj2mqXWIY14iOKs')));
  assert.equal(order.paid, true); assert.equal(order.offer, OFFERS.price_1UgVjLLmNyj2mqXWIY14iOKs);
});

test('rejects an unpaid approved session', async () => {
  const order = await verifiedOrder('cs_test_valid123', stripe(session('price_1UgVjLLmNyj2mqXWIY14iOKs', 'unpaid')));
  assert.equal(order.paid, false);
});

test('rejects an unrelated Stripe price', async () => {
  const order = await verifiedOrder('cs_test_valid123', stripe(session('price_unrelated')));
  assert.equal(order.paid, false); assert.equal(order.offer, undefined);
});

test('rejects a mismatched amount', async () => {
  const order = await verifiedOrder('cs_test_valid123', stripe(session('price_1UgVjLLmNyj2mqXWIY14iOKs', 'paid', 1)));
  assert.equal(order.paid, false);
});

test('signed links validate, detect tampering, and expire', () => {
  const token = signDownload('cs_test_valid123', 'playbook', Date.now() + 60_000);
  assert.deepEqual(verifyDownload(token)?.f, 'playbook');
  assert.equal(verifyDownload(`${token}x`), null);
  assert.equal(verifyDownload(signDownload('cs_test_valid123', 'playbook', Date.now() - 1)), null);
});

test('Toolkit grants both files and Playbook grants PDF only', () => {
  assert.deepEqual(OFFERS.price_1UgVjLLmNyj2mqXWIY14iOKs.files, ['playbook']);
  assert.deepEqual(OFFERS.price_1UgVjeLmNyj2mqXWbUFyLxVx.files, ['playbook', 'toolkit']);
  assert.deepEqual(OFFERS.price_1UgVjwLmNyj2mqXWiUn6c6pr.files, []);
});
