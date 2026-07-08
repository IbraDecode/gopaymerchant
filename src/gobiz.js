const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs')
const log = require('./logger')

const API = 'https://api.gobiz.co.id'

function uid() { return crypto.randomUUID() }

class GoBiz {
  constructor() {
    this.token = null
    this.idMerchant = null
    this.serverKey = null
    this.clientKey = null
  }

  simpan(file, extra) {
    fs.writeFileSync(file, JSON.stringify({
      token: this.token,
      idMerchant: this.idMerchant,
      serverKey: this.serverKey,
      clientKey: this.clientKey,
      ...(extra || {})
    }, null, 2))
  }

  muat(file) {
    if (!fs.existsSync(file)) return false
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.token = d.token
      this.idMerchant = d.idMerchant
      this.serverKey = d.serverKey
      this.clientKey = d.clientKey
      return true
    } catch { return false }
  }

  header() {
    return {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'accept-language': 'id',
      'authorization': this.token ? 'Bearer ' + this.token : 'Bearer',
      'x-user-type': 'merchant',
      'authentication-type': 'go-id',
      'gojek-country-code': 'ID',
      'gojek-timezone': 'UTC',
      'x-appid': 'go-biz-web-dashboard',
      'x-appversion': 'auth-v1.200.0-0a1b2c3d',
      'x-platform': 'Web',
      'x-deviceos': 'Web',
      'x-phonemake': 'Linux 64-bit',
      'x-phonemodel': 'Chrome 148',
      'x-uniqueid': uid(),
      'x-user-locale': 'en-US',
      'referer': 'https://portal.gofoodmerchant.co.id/',
      'origin': 'https://portal.gofoodmerchant.co.id',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
    }
  }

  async loginEmail(email, password) {
    log.step('Masuk ke GoPay Merchant')
    const headers = this.header()

    const req = await axios.post(API + '/goid/login/request', {
      email, login_type: 'password', client_id: 'go-biz-web-new'
    }, { headers, timeout: 15000 })

    if (!req.data?.success) {
      throw new Error(req.data?.errors?.[0]?.message || 'Gagal verifikasi email')
    }

    const res = await axios.post(API + '/goid/token', {
      client_id: 'go-biz-web-new',
      grant_type: 'password',
      data: { email, password }
    }, { headers, timeout: 15000 })

    if (!res.data?.access_token) {
      throw new Error(res.data?.errors?.[0]?.message || 'Email atau password salah')
    }

    this.token = res.data.access_token
    log.ok('Berhasil masuk')
    return this.token
  }

  async mintaOTP(phone) {
    const bersih = phone.replace(/^62/, '').replace(/^0/, '')
    const res = await axios.post(API + '/goid/login/request', {
      client_id: 'go-biz-web-new', phone_number: bersih, country_code: '62'
    }, { headers: this.header(), timeout: 15000 })

    if (res.status === 201 && res.data.success) {
      return res.data.data.otp_token
    }
    throw new Error(res.data.errors?.[0]?.message || 'Gagal kirim OTP')
  }

  async loginOTP(phone, otpToken, kodeOtp) {
    const res = await axios.post(API + '/goid/token', {
      client_id: 'go-biz-web-new',
      data: { otp: kodeOtp, otp_token: otpToken },
      grant_type: 'otp'
    }, { headers: this.header(), timeout: 15000 })

    if (!res.data?.access_token) {
      throw new Error(res.data?.errors?.[0]?.message || 'Kode OTP salah atau kadaluwarsa')
    }

    this.token = res.data.access_token
    return this.token
  }

  async ambilProfil() {
    const res = await axios.get(API + '/v1/users/me', { headers: this.header(), timeout: 15000 })
    if (!res.data?.user) throw new Error('Gagal ambil profil: response tidak valid')
    const u = res.data.user
    this.idMerchant = u.merchant_id
    return u
  }

  async ambilMerchant() {
    if (!this.idMerchant) throw new Error('Belum login. jalankan: node . login')
    const res = await axios.get(API + '/v1/merchants/' + this.idMerchant, { headers: this.header(), timeout: 15000 })
    if (!res.data?.server_key) throw new Error('Gagal ambil data merchant: response tidak valid')
    this.serverKey = res.data.server_key
    this.clientKey = res.data.client_key
    return res.data
  }

  async ambilTransaksi(hari) {
    const rentang = Math.max(1, Math.min(365, parseInt(hari) || 7))
    const dari = new Date(Date.now() - rentang * 86400000).toISOString()
    const ke = new Date().toISOString()

    const res = await axios.post(API + '/journals/search', {
      from: 0, size: 20,
      sort: { time: { order: 'desc' } },
      included_categories: { incoming: ['transaction_share', 'action'] },
      query: [{
        clauses: [
          { field: 'time', op: 'gte', value: dari },
          { field: 'time', op: 'lte', value: ke }
        ], op: 'and'
      }]
    }, { headers: this.header() })

    return (res.data.hits || []).map(h => {
      const tx = h.metadata?.transaction || {}
      return {
        id: h.reference_id,
        waktu: h.time,
        status: h.status,
        jumlah: (h.amount || 0) / 100,
        gross: (tx.real_gross_amount || h.amount || 0) / 100,
        metode: (tx.payment_type || '').toUpperCase(),
        penerbit: tx.metadata?.aspi_qr_issuer || tx.metadata?.issuer || '-',
        pesanan: tx.order_id || '-'
      }
    })
  }
}

module.exports = GoBiz
