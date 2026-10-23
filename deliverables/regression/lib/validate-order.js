// Shared runtime body used by the validator's Edit Fields expression.
// `request` is a declared string and `rows` is an array of already matched rows.
function validateOrder(request, rows) {
  if (!Array.isArray(rows)) throw new Error('Expected matched rows array');
  if (rows.length === 0) return { lookup_status: 'not_found', order: null };
  if (rows.length > 1) return { lookup_status: 'duplicate', order: null };
  const row = rows[0] ?? {};
  const invalid_fields = [];
  const order = {};
  const text = key => typeof row[key] === 'string' ? row[key].trim() : null;
  const fail = key => invalid_fields.push(key);
  order.order_number = text('order_number');
  if (!order.order_number || !/^\d+$/.test(order.order_number) || order.order_number !== request) fail('order_number');
  order.customer_email = text('customer_email')?.toLowerCase() ?? null;
  // One bare mailbox: dot-atom local part and DNS-style domain labels.
  const email = order.customer_email;
  if (!email || email.length > 254 || !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email) || email.split('@')[0].length > 64 || email.split('@')[1].split('.').some(label => label.length > 63)) fail('customer_email');
  order.status = text('status')?.toLowerCase() ?? null;
  if (!['processing', 'shipped', 'delivered'].includes(order.status)) fail('status');
  order.item = text('item');
  if (!order.item) fail('item');
  for (const key of ['tracking_number', 'estimated_delivery']) {
    if (row[key] == null) order[key] = null;
    else if (typeof row[key] !== 'string') { order[key] = null; fail(key); }
    else order[key] = row[key].trim() || null;
  }
  if (order.estimated_delivery) {
    const value = order.estimated_delivery;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) fail('estimated_delivery');
    else {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('estimated_delivery');
    }
  }
  return invalid_fields.length
    ? { lookup_status: 'invalid_data', order: null, reason: 'invalid_order_data', invalid_fields }
    : { lookup_status: 'found', order };
}

module.exports = { validateOrder };
