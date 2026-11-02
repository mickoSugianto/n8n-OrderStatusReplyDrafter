const base = { order_number: '1001', customer_email: 'buyer@example.com', status: 'shipped', item: 'Mug', tracking_number: 'TrK-1001', estimated_delivery: '2026-10-20' };
const cases = [];
function add(id, rows, expected, fields = [], order_number = '1001', expectedOrder = null, mode = 'validation') {
  cases.push({ id, mode, order_number, rows, expected, fields, expectedOrder, message_id: `message-${id}`, thread_id: `thread-${id}`, subject: `Order ${order_number}` });
}
function bad(id, field, value, missing = false) {
  const row = { ...base, [field]: value };
  if (missing) delete row[field];
  add(id, [row], 'invalid_data', [field]);
}
add('zero', [], 'not_found');
add('valid', [base], 'found', [], '1001', base);
add('duplicate', [base, base], 'duplicate');
add('duplicate-before-validation', [base, { ...base, status: 'unknown-value' }], 'duplicate');
for (const field of ['order_number', 'customer_email', 'status', 'item']) {
  bad(`missing-${field}`, field, undefined, true);
  bad(`blank-${field}`, field, '  ');
  bad(`null-${field}`, field, null);
  for (const [type, value] of [['number', 1001], ['boolean', true], ['object', {}], ['array', []]]) bad(`${type}-${field}`, field, value);
}
bad('non-digit-order', 'order_number', 'A1001');
bad('mismatched-order', 'order_number', '1002');
bad('leading-zero-not-equal', 'order_number', '001001');
for (const email of ['not-an-address', 'a@example.com,b@example.com', 'a@example.com; b@example.com', 'a..b@example.com', 'a@-example.com', 'a@example..com']) bad(`email-${cases.length}`, 'customer_email', email);
bad('unsupported-status', 'status', 'unknown-value');
for (const field of ['tracking_number', 'estimated_delivery']) {
  for (const [type, value] of [['number', 46000], ['boolean', true], ['object', {}], ['array', []]]) bad(`${type}-${field}`, field, value);
  for (const [kind, value] of [['missing', undefined], ['null', null], ['empty', ''], ['whitespace', '  ']]) {
    const row = { ...base, [field]: value };
    if (kind === 'missing') delete row[field];
    add(`${kind}-optional-${field}`, [row], 'found', [], '1001', { ...base, [field]: null });
  }
}
for (const value of ['2026-02-30', 'tomorrow', '2026-10-20T12:00:00Z', '2026-10-20 to 2026-10-22', '2026-02-29', '1900-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '2026-04-31', '0000-01-01']) bad(`invalid-date-${value}`, 'estimated_delivery', value);
for (const value of ['2026-10-20', '2024-02-29', '2000-02-29', '2026-02-28']) add(`valid-date-${value}`, [{ ...base, estimated_delivery: value }], 'found', [], '1001', { ...base, estimated_delivery: value });
for (const status of ['processing', 'shipped', 'delivered']) {
  const expected = { ...base, status, tracking_number: null, estimated_delivery: null };
  add(`normalized-${status}`, [{ order_number: ' 1001 ', customer_email: ' BUYER@EXAMPLE.COM ', status: ` ${status.toUpperCase()} `, item: ' Mug ', tracking_number: null, estimated_delivery: '' }], 'found', [], '1001', expected);
}
add('trim-and-preserve', [{ ...base, item: ' Mug ', tracking_number: ' TrK-10 01 ', estimated_delivery: ' 2026-10-20 ' }], 'found', [], '1001', { ...base, tracking_number: 'TrK-10 01' });
add('leading-zero', [{ ...base, order_number: '001001' }], 'found', [], '001001', { ...base, order_number: '001001' });
const account = process.env.FIXTURE_ACCOUNT;
if (account) {
  const demo = [
    { order_number: '1001', customer_email: account, status: 'shipped', item: 'Ceramic mug set', tracking_number: 'TRK1001', estimated_delivery: '2026-10-20' },
    { order_number: '1002', customer_email: account, status: 'processing', item: 'Linen tote bag', tracking_number: null, estimated_delivery: null },
    { order_number: '1003', customer_email: account, status: 'delivered', item: 'Soy candle', tracking_number: 'TRK1003', estimated_delivery: null },
  ];
  for (const row of demo) add(`live-${row.order_number}`, [], 'found', [], row.order_number, row, 'lookup');
  add('live-not-found', [], 'not_found', [], '9999', null, 'lookup');
}
module.exports = { cases, base, add };
if (require.main === module) process.stdout.write(JSON.stringify(cases, null, 2));
