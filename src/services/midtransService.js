/**
 * services/midtransService.js — QRIS via Midtrans Core API v2
 *
 * Dipakai Paywall QRIS-only (Placement_Test_System.md Fase 5):
 *   createQris()      POST /v2/qris            → { qr_string, qr_code_url, expiry_time }
 *   checkStatus()     GET  /v2/:orderId/status → { transaction_status, ... }
 *   verifyWebhook()   SHA-512 signature check  → boolean
 *
 * Env: MIDTRANS_SERVER_KEY, MIDTRANS_CLIENT_KEY, MIDTRANS_SANDBOX=true|false
 */
const axios = require('axios');
const crypto = require('crypto');

const IS_SANDBOX = String(process.env.MIDTRANS_SANDBOX || 'true').toLowerCase() !== 'false';
const BASE_URL = IS_SANDBOX
  ? 'https://api.sandbox.midtrans.com'
  : 'https://api.midtrans.com';

function serverKey() {
  const k = process.env.MIDTRANS_SERVER_KEY;
  if (!k) throw new Error('MIDTRANS_SERVER_KEY belum di-set di .env');
  return k;
}

function authConfig() {
  return { auth: { username: serverKey(), password: '' } };
}

/**
 * Buat transaksi QRIS dinamis.
 * @param {{orderId:string, grossAmount:number, itemName:string, customer?:object}} p
 * @returns {{qr_string:string, qr_code_url:string|null, expiry_time:string|null}}
 */
async function createQris({ orderId, grossAmount, itemName }) {
  if (!orderId || !grossAmount || grossAmount <= 0) {
    throw Object.assign(new Error('orderId dan grossAmount wajib'), { status: 400 });
  }
  try {
    const res = await axios.post(`${BASE_URL}/v2/charge`, {
      payment_type: 'qris',
      qris: { acquirer: 'gopay' },
      transaction_details: { order_id: orderId, gross_amount: grossAmount },
      item_details: [{
        id: 'PAKET', price: grossAmount, quantity: 1, name: itemName || 'Paket Level Cadas',
      }],
      customer_details: { first_name: 'Cadas User' },
    }, authConfig());

    const d = res.data || {};
    return {
      qr_string: d.qr_string || null,
      qr_code_url: d.qr_code_url || null,
      expiry_time: d.expiry_time || null,
      raw: d,
    };
  } catch (err) {
    const apiMsg = err.response?.data?.error_messages || err.response?.data || err.message;
    console.error('[midtrans/createQris]', JSON.stringify(apiMsg));
    throw Object.assign(new Error('Gagal membuat QRIS Midtrans'), { status: 502 });
  }
}

/**
 * Cek status transaksi (dipakai polling & fallback webhook).
 * @returns {{transaction_status:string, order_id:string, raw:object}}
 */
async function checkStatus(orderId) {
  try {
    const res = await axios.get(`${BASE_URL}/v2/${encodeURIComponent(orderId)}/status`, authConfig());
    const d = res.data || {};
    return {
      transaction_status: String(d.transaction_status || '').toLowerCase(),
      order_id: d.order_id || orderId,
      raw: d,
    };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      throw Object.assign(new Error('Transaksi Midtrans tidak ditemukan'), { status: 404 });
    }
    console.error('[midtrans/checkStatus]', err.response?.data || err.message);
    throw Object.assign(new Error('Gagal cek status Midtrans'), { status: 502 });
  }
}

/** Status Midtrans yang dianggap SUDAH DIBAYAR. */
const PAID_STATUSES = ['settlement', 'paid', 'capture'];

function isPaid(transactionStatus) {
  return PAID_STATUSES.includes(String(transactionStatus || '').toLowerCase());
}

/** Status yang dianggap kedaluwarsa / dibatalkan. */
const FAILED_STATUSES = ['expire', 'expired', 'deny', 'cancel', 'failure', 'refund'];

function isFailed(transactionStatus) {
  return FAILED_STATUSES.includes(String(transactionStatus || '').toLowerCase());
}

/**
 * Verifikasi signature webhook notification:
 * signature_key == SHA512(order_id + status_code + gross_amount + serverKey)
 */
function verifyWebhook(payload) {
  if (!payload || !payload.signature_key) return false;
  const expected = crypto.createHash('sha512')
    .update(
      String(payload.order_id || '') +
      String(payload.status_code || '') +
      String(payload.gross_amount || '') +
      serverKey()
    )
    .digest('hex');
  return expected === String(payload.signature_key).toLowerCase();
}

module.exports = {
  BASE_URL,
  createQris,
  checkStatus,
  isPaid,
  isFailed,
  verifyWebhook,
};
