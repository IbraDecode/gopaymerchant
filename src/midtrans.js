const axios = require('axios')
const log = require('./logger')

class Midtrans {
  constructor(kunciServer) {
    if (!kunciServer) throw new Error('Server Key Midtrans diperlukan')
    this.kunci = kunciServer
    this.auth = Buffer.from(kunciServer + ':').toString('base64')
    this.header = {
      'authorization': 'Basic ' + this.auth,
      'content-type': 'application/json',
      'accept': 'application/json'
    }
  }

  async post(host, path, data) {
    const r = await axios.post(host + path, data, { headers: this.header, timeout: 15000 })
    return r.data
  }

  async get(host, path) {
    const r = await axios.get(host + path, { headers: this.header, timeout: 15000 })
    return r.data
  }

  async postHead(host, path, data, extraHeaders) {
    const r = await axios.post(host + path, data, {
      headers: { ...this.header, ...extraHeaders },
      timeout: 15000
    })
    return r.data
  }

  async buatQRIS(idPesanan, jumlah, webhookUrl) {
    log.step('Bikin QRIS ' + formatRp(jumlah))

    const headers = webhookUrl ? { 'X-Override-Notification': webhookUrl } : {}
    const snap = await this.postHead('https://app.midtrans.com', '/snap/v1/transactions', {
      transaction_details: { order_id: idPesanan, gross_amount: jumlah }
    }, headers)

    if (!snap.token) {
      throw new Error(snap.status_message || 'Gagal bikin Snap token')
    }

    const charge = await this.postHead('https://app.midtrans.com', '/snap/v2/transactions/' + snap.token + '/charge', {
      promo_details: null,
      payment_type: 'other_qris'
    }, headers)

    if (charge.status_code !== '201') {
      throw new Error(charge.status_message || 'Gagal charge QRIS')
    }

    log.ok('QRIS berhasil dibuat')

    return {
      idPesanan: charge.order_id,
      idTransaksi: charge.transaction_id,
      jumlah: Number(charge.gross_amount),
      idMerchant: charge.merchant_id,
      stringQR: charge.qr_string,
      urlGambar: charge.qris_url,
      kadaluarsa: charge.expiry_time,
      status: charge.transaction_status,
      akuisitor: charge.acquirer
    }
  }

  async cekStatus(idPesanan, silent) {
    if (!silent) log.step('Cek status ' + idPesanan)
    let r
    try {
      r = await this.get('https://api.midtrans.com', '/v2/' + idPesanan + '/status')
    } catch (e) {
      if (e.response?.status === 404) {
        return { status: 'not_found', metode: '-', jumlah: 0, waktu: '-', penerbit: '-', akuisitor: '-', fraud: '-', tipe: '-' }
      }
      throw e
    }
    return {
      status: r.transaction_status || 'unknown',
      metode: r.payment_type || '-',
      jumlah: Number(r.gross_amount || 0),
      waktu: r.settlement_time || r.transaction_time || '-',
      penerbit: r.issuer || '-',
      akuisitor: r.acquirer || '-',
      fraud: r.fraud_status || '-',
      tipe: r.transaction_type || '-'
    }
  }

  async batalkan(idPesanan) {
    log.step('Batalkan ' + idPesanan)
    return await this.post('https://api.midtrans.com', '/v2/' + idPesanan + '/cancel', {})
  }

  async kedaluwarsakan(idPesanan) {
    log.step('Kadaluwarsakan ' + idPesanan)
    return await this.post('https://api.midtrans.com', '/v2/' + idPesanan + '/expire', {})
  }

  async refund(idPesanan, jumlah, alasan) {
    log.step('Refund ' + idPesanan + ' ' + formatRp(jumlah))
    return await this.post('https://api.midtrans.com', '/v2/' + idPesanan + '/refund', {
      refund_key: 'RFND-' + Date.now(),
      amount: jumlah,
      reason: alasan || 'Refund by merchant'
    })
  }

  async saldo(dari, ke) {
    const enc = s => encodeURIComponent(s)
    log.step('Cek saldo')
    return await this.get('https://api.midtrans.com',
      '/v1/balance/mutation?currency=IDR&start_time=' + enc(dari) + '&end_time=' + enc(ke))
  }

  async buatPaymentLink(idPesanan, jumlah) {
    log.step('Bikin payment link ' + formatRp(jumlah))
    const r = await this.post('https://api.midtrans.com', '/v1/payment-links', {
      transaction_details: {
        order_id: idPesanan,
        gross_amount: jumlah,
        payment_link_id: 'pl-' + Date.now()
      },
      usage_limit: 1,
      expiry: { duration: 60, unit: 'minutes' },
      enabled_payments: ['gopay', 'other_qris', 'qris']
    })
    log.ok('Payment link berhasil dibuat')
    return {
      idPesanan: r.order_id,
      jumlah: Number(r.gross_amount || jumlah),
      urlBayar: r.payment_url,
      urlQR: r.qr_url
    }
  }
}

function formatRp(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID')
}

module.exports = Midtrans
