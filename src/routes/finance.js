/** Finance routes — separate from marketing/admin marketing routes. */
const express = require('express');
const router = express.Router();
const finance = require('../services/financeReportService');
const { requireAuth, requireRole } = require('../middleware/auth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor = (req) => {
  const raw = req.auth?.id || req.auth?.sub || null;
  return { id: UUID_RE.test(String(raw || '')) ? raw : null, role: 'admin' };
};
const send = async (res, fn) => { try { await fn(); } catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message }); } };

router.use(requireAuth, requireRole('admin'));

router.get('/summary', (req, res) => send(res, async () => res.json(await finance.summary(req.query))));
router.get('/payments', (req, res) => send(res, async () => res.json({ payments: await finance.payments(req.query) })));
router.get('/earnings', (req, res) => send(res, async () => res.json({ earnings: await finance.earnings(req.query) })));
router.get('/cancellations', (req, res) => send(res, async () => res.json({ cancellations: await finance.cancellations(req.query) })));
router.get('/payouts', (req, res) => send(res, async () => res.json(await finance.payouts(req.query))));
router.get('/audit', (req, res) => send(res, async () => res.json({ audit: await finance.audit(req.query) })));
router.get('/reconciliation', (req, res) => send(res, async () => res.json(await finance.reconciliation(req.query))));
router.get('/windows', (req, res) => send(res, async () => res.json({ windows: await finance.windows(req.query) })));
router.get('/scheduler-runs', (req, res) => send(res, async () => res.json({ runs: await finance.schedulerRuns(req.query.limit) })));
router.post('/scheduler/run', (req, res) => send(res, async () => res.status(201).json(await finance.runFinanceMaintenance({ windowIds: req.body?.window_ids }))));

router.post('/cash-ledger/backfill', (req, res) => send(res, async () => res.json(await finance.backfillSettlementLedger())));
router.post('/payout-batches', (req, res) => send(res, async () => res.status(201).json(await finance.createPayoutBatch({ earningIds:req.body?.earning_ids, notes:req.body?.notes, actor:actor(req) }))));
router.post('/payout-batches/:id/transferred', (req, res) => send(res, async () => res.json(await finance.markBatchTransferred({ batchId:req.params.id, bankReference:req.body?.bank_reference, notes:req.body?.notes, actor:actor(req) }))));
router.post('/earnings/:id/cancel', (req, res) => send(res, async () => res.json(await finance.cancelEarning({ earningId:req.params.id, reason:req.body?.reason, actor:actor(req) }))));
router.post('/reconciliation', (req, res) => send(res, async () => res.status(201).json(await finance.saveReconciliation({ accountName:req.body?.account_name, accountDate:req.body?.account_date, actualBalanceIdr:req.body?.actual_balance_idr, notes:req.body?.notes, actor:actor(req) }))));

router.get('/export/:type', (req, res) => send(res, async () => {
  const type = req.params.type;
  const q = req.query;
  let rows = [], filename = 'finance-report';
  if (type === 'payments') { rows = await finance.payments(q); filename = 'finance-payments'; }
  else if (type === 'earnings') { rows = await finance.earnings(q); filename = 'finance-earnings'; }
  else if (type === 'cancellations') { rows = await finance.cancellations(q); filename = 'finance-cancellations'; }
  else if (type === 'payouts') { const x = await finance.payouts(q); rows = x.batches; filename = 'finance-payouts'; }
  else if (type === 'audit') { rows = await finance.audit(q); filename = 'finance-audit'; }
  else if (type === 'windows') { rows = await finance.windows(q); filename = 'finance-windows'; }
  else if (type === 'scheduler-runs') { rows = await finance.schedulerRuns(q.limit || 100); filename = 'finance-scheduler-runs'; }
  else if (type === 'summary') { rows = [await finance.summary(q)]; filename = 'finance-summary'; }
  else return res.status(400).json({ error: 'type tidak dikenal' });
  const format = String(q.format || 'csv').toLowerCase();
  if (format === 'json') { res.setHeader('Content-Type','application/json; charset=utf-8'); return res.json({ type, rows }); }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(finance.csv(rows));
}));

module.exports = router;
