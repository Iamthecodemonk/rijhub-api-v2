import Wallet from '../models/Wallet.js';
import Artisan from '../models/Artisan.js';
import { getConfig } from './config.js';
import { ensurePaystackSubaccount } from './payout.js';

export async function calculateCompanyFee(amount) {
  let feePct = 0;
  const cfgVal = await getConfig('COMPANY_FEE_PCT');
  if (cfgVal !== null && !isNaN(Number(cfgVal))) feePct = Number(cfgVal);
  const companyFee = Math.round(((Number(amount || 0) * feePct) / 100) * 100) / 100;
  return { feePct, companyFee };
}

export async function buildPaystackSplitParams({ artisanUserId, amount, request }) {
  if (!artisanUserId || !process.env.PAYSTACK_SECRET_KEY) {
    return { enabled: false, params: {}, meta: { reason: 'missing_artisan_or_paystack' } };
  }

  const artisanDoc = await Artisan.findOne({ userId: artisanUserId });
  const wallet = await Wallet.findOne({ userId: artisanUserId });
  if (!wallet) {
    request?.log?.warn?.({ artisanUserId: String(artisanUserId) }, 'paystack split skipped: artisan wallet not found');
    return { enabled: false, params: {}, meta: { reason: 'wallet_not_found' } };
  }

  const subaccountCode = await ensurePaystackSubaccount({ wallet, artisanDoc, request });
  if (!subaccountCode) {
    request?.log?.warn?.({ artisanUserId: String(artisanUserId) }, 'paystack split skipped: no subaccount code');
    return { enabled: false, params: {}, meta: { reason: 'subaccount_unavailable' } };
  }

  const { feePct, companyFee } = await calculateCompanyFee(amount);
  const transactionCharge = Math.round(companyFee * 100);

  const params = {
    subaccount: subaccountCode,
    transaction_charge: transactionCharge,
    bearer: process.env.PAYSTACK_SPLIT_BEARER || 'account',
  };

  const meta = {
    subaccountCode,
    feePct,
    companyFee,
    transactionCharge,
    bearer: params.bearer,
    transferAmount: Math.round((Number(amount || 0) - companyFee) * 100) / 100,
  };

  request?.log?.info?.({
    artisanUserId: String(artisanUserId),
    amount: Number(amount || 0),
    feePct,
    companyFee,
    transactionCharge,
    bearer: params.bearer,
    hasSubaccountCode: !!subaccountCode,
  }, 'paystack split params prepared');

  return { enabled: true, params, meta };
}
