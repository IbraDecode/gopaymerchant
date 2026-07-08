#!/usr/bin/env node
const QRCode = require('qrcode')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const readline = require('readline')
const log = require('./src/logger')
const GoBiz = require('./src/gobiz')
const Midtrans = require('./src/midtrans')

const FILE_CONFIG = path.join(__dirname, 'config.json')
const FILE_HISTORY = path.join(__dirname, 'history.json')

// ─── BANTUAN ────────────────────────────────

function bacaConfig() {
  if (!fs.existsSync(FILE_CONFIG)) return null
  return JSON.parse(fs.readFileSync(FILE_CONFIG, 'utf8'))
}

function cfgOrEnv(key) {
  const cfg = bacaConfig()
  if (cfg?.[key]) return cfg[key]
  const envKey = 'GOPAY_' + key.replace(/([A-Z])/g, '_$1').toUpperCase()
  if (process.env[envKey]) return process.env[envKey]
  return null
}

function formatRp(n) {
  return 'Rp ' + Number(n).toLocaleString('id-ID')
}

function mask(str, show = 3) {
  if (!str) return '-'
  if (str.length <= show + 3) return str.substring(0, 1) + '***'
  const first = str.substring(0, Math.min(show, str.length - 4))
  if (str.includes('@')) {
    const [local] = str.split('@')
    const domain = str.split('@')[1] || ''
    return local.substring(0, 1) + '***@' + domain
  }
  if (str.startsWith('Mid-server-')) {
    return 'Mid-server-' + str.substring(11, 13) + '****'
  }
  if (str.startsWith('Mid-client-')) {
    return 'Mid-client-' + str.substring(11, 13) + '****'
  }
  if (str.startsWith('G') && str.length === 9) {
    return 'G****' + str.substring(str.length - 3)
  }
  if (str.startsWith('QRIS-') || str.startsWith('PAYLINK-')) {
    return str
  }
  const last = str.substring(str.length - 2)
  return first + '***' + last
}

function maskName(str) {
  if (!str) return '-'
  const parts = str.split(' ')
  if (parts.length === 1) return parts[0].substring(0, 1) + '***'
  return parts[0] + ' ' + parts[1].substring(0, 1) + '***'
}

function maskPhone(str) {
  if (!str) return '-'
  if (str.length <= 6) return '***' + str.substring(str.length - 2)
  return str.substring(0, 2) + '****' + str.substring(str.length - 3)
}

function tanya(p, silent) {
  if (!silent || !process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(r => rl.question(p, a => { rl.close(); r(a) }))
  }

  // Silent mode: mask input with asterisks
  process.stdout.write(p)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()

  return new Promise(r => {
    let buf = ''
    const onData = (c) => {
      const char = c.toString()
      switch (char) {
        case '\r':
        case '\n':
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          r(buf)
          break
        case '\x7f':
        case '\b':
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            process.stdout.write('\b \b')
          }
          break
        case '\x03':
          process.exit(0)
          break
        default:
          if (char >= ' ' && !char.startsWith('\x1b')) {
            buf += char
            process.stdout.write('*')
          }
      }
    }
    stdin.on('data', onData)
  })
}

function statusLabel(s) {
  const m = {
    pending: '\x1b[33mpending\x1b[0m',
    settlement: '\x1b[32msettlement\x1b[0m',
    expire: '\x1b[31mexpire\x1b[0m',
    cancel: '\x1b[31mcancel\x1b[0m',
    refund: '\x1b[35mrefund\x1b[0m',
    deny: '\x1b[31mdeny\x1b[0m',
    success: '\x1b[32msukses\x1b[0m',
    failed: '\x1b[31mgagal\x1b[0m'
  }
  return m[s?.toLowerCase()] || s || '-'
}

// ─── ANIMATION ────────────────────────────────

let spinTimer = null

function spinnerStart(msg) {
  const frames = ['\u280B', '\u2819', '\u2839', '\u2838',
                  '\u283C', '\u2834', '\u2826', '\u2827',
                  '\u2807', '\u280F']
  const colors = [log.C.cyan, log.C.white, log.C.green, log.C.white]
  let i = 0
  process.stdout.write('  ' + msg + '  ')
  spinTimer = setInterval(() => {
    process.stdout.write('\b\b' + colors[i % colors.length] + frames[i % frames.length] + log.C.rs + ' ')
    i++
  }, 80)
}

function spinnerStop(fail) {
  if (spinTimer) {
    clearInterval(spinTimer)
    spinTimer = null
    const icon = fail ? '\u2717' : '\u2713'
    const color = fail ? log.C.red : log.C.green
    process.stdout.write('\b\b' + color + log.C.b + icon + log.C.rs + ' \n')
  }
}

function progressBar(current, total, label) {
  const w = 30
  const pct = Math.min(current / total, 1)
  const filled = Math.round(pct * w)
  const empty = w - filled
  const fullBar = log.C.green + '\u2588'.repeat(filled) + log.C.rs
  const emptyBar = log.C.gray + '\u2591'.repeat(empty) + log.C.rs
  const bar = fullBar + emptyBar
  const pctStr = (pct * 100).toFixed(0).padStart(3)
  process.stdout.write('\r  ' + bar + ' ' + log.C.b + log.C.white + pctStr + '%' + log.C.rs + ' ' + log.C.gray + (label || '') + log.C.rs + '   ')
  if (current >= total) {
    process.stdout.write(log.C.green + '\u2713' + log.C.rs + '\n')
  }
}

function progressSmooth(duration, msg, cb) {
  const start = Date.now()
  const w = 25
  let stopped = false

  function tick() {
    if (stopped) return
    const elapsed = Date.now() - start
    const pct = Math.min(elapsed / duration, 1)
    const filled = Math.round(pct * w)
    const empty = w - filled
    const fullBar = log.C.cyan + '\u2588'.repeat(filled) + log.C.rs
    const emptyBar = log.C.gray + '\u2591'.repeat(empty) + log.C.rs
    const bar = fullBar + emptyBar
    const pctStr = (pct * 100).toFixed(0).padStart(3)
    process.stdout.write('\r  ' + bar + ' ' + log.C.b + log.C.white + pctStr + '%' + log.C.rs + ' ' + log.C.gray + msg + log.C.rs + '   ')
    if (pct >= 1) {
      process.stdout.write(log.C.green + '\u2713' + log.C.rs + '\n')
      if (cb) cb()
    } else {
      setTimeout(tick, 100)
    }
  }
  tick()
  return () => { stopped = true }
}

let typeTimer = null

function typewrite(text, cb, i) {
  i = i || 0
  if (i === 0) process.stdout.write('  ')
  if (i < text.length) {
    const colors = [log.C.cyan, log.C.green, log.C.white, log.C.green]
    process.stdout.write(colors[i % colors.length] + text[i] + log.C.rs)
    typeTimer = setTimeout(() => typewrite(text, cb, i + 1), 12)
  } else {
    console.log()
    if (cb) setTimeout(cb, 200)
  }
}

function typeStop() {
  if (typeTimer) { clearTimeout(typeTimer); typeTimer = null }
}

// ─── HISTORY ─────────────────────────────────

function historyPush(entry) {
  let hist = []
  try {
    if (fs.existsSync(FILE_HISTORY))
      hist = JSON.parse(fs.readFileSync(FILE_HISTORY, 'utf8'))
  } catch {}
  hist.push({ ...entry, ts: new Date().toISOString() })
  if (hist.length > 500) hist = hist.slice(-500)
  fs.writeFileSync(FILE_HISTORY, JSON.stringify(hist, null, 2))
}

function historyList(limit = 10) {
  try {
    if (!fs.existsSync(FILE_HISTORY)) return []
    return JSON.parse(fs.readFileSync(FILE_HISTORY, 'utf8')).slice(-limit).reverse()
  } catch { return [] }
}

function historyStats() {
  const entries = historyList(500)
  const total = entries.length
  const amount = entries.reduce((s, e) => s + (e.jumlah || 0), 0)
  return { total, amount }
}

// ─── HEADER ─────────────────────────────────

function header() {
  const g = [log.C.cyan, log.C.green, log.C.white, log.C.green, log.C.cyan, log.C.gray]
  const n = log.C.rs
  console.log()
  console.log('  ' + g[0] + log.C.b + '   ______      ____            ' + n)
  console.log('  ' + g[1] + '  / ____/___  / __ \\____ ___  __' + n)
  console.log('  ' + g[2] + ' / / __/ __ \\/ /_/ / __ \\/ / / /' + n)
  console.log('  ' + g[3] + '/ /_/ / /_/ / ____/ /_/ / /_/ / ' + n)
  console.log('  ' + g[4] + '\\____/\\____/_/    \\__,_/\\__, /  ' + n)
  console.log('  ' + g[5] + log.C.d + '                        /____/   ' + n)
  console.log()
  console.log('  ' + log.C.gray + log.C.d + 'qris  paylink  refund  webhook  login' + log.C.rs)
  log.ln()
}

function menu() {
  header()
  console.log()
  console.log('  ' + log.C.cyan + log.C.b + 'MENU / ENGLISH' + log.C.rs)
  console.log()
  log.label('PAYMENTS')
  console.log('    ' + log.C.cyan + '1' + log.C.rs + '  ' + log.C.b + log.C.white + 'QRIS' + log.C.rs + '         ' + log.C.gray + 'generate dynamic or static QRIS' + log.C.rs)
  console.log('    ' + log.C.cyan + '2' + log.C.rs + '  ' + log.C.b + log.C.white + 'Payment Link' + log.C.rs + '  ' + log.C.gray + 'create payment link with QR code' + log.C.rs)
  console.log()
  log.label('TRANSACTIONS')
  console.log('    ' + log.C.cyan + '3' + log.C.rs + '  ' + log.C.b + log.C.white + 'Status' + log.C.rs + '       ' + log.C.gray + 'check transaction status' + log.C.rs)
  console.log('    ' + log.C.cyan + '4' + log.C.rs + '  ' + log.C.b + log.C.white + 'Monitor' + log.C.rs + '      ' + log.C.gray + 'watch transaction in real-time' + log.C.rs)
  console.log('    ' + log.C.cyan + '5' + log.C.rs + '  ' + log.C.b + log.C.white + 'Cancel' + log.C.rs + '       ' + log.C.gray + 'cancel, expire, or refund' + log.C.rs)
  console.log()
  log.label('REPORTS')
  console.log('    ' + log.C.cyan + '6' + log.C.rs + '  ' + log.C.b + log.C.white + 'Transactions' + log.C.rs + '  ' + log.C.gray + 'list transactions' + log.C.rs)
  console.log('    ' + log.C.cyan + '7' + log.C.rs + '  ' + log.C.b + log.C.white + 'Balance' + log.C.rs + '      ' + log.C.gray + 'view balance mutation' + log.C.rs)
  console.log()
  log.label('ACCOUNT')
  console.log('    ' + log.C.cyan + '8' + log.C.rs + '  ' + log.C.b + log.C.white + 'Login' + log.C.rs + '        ' + log.C.gray + 'login GoPay Merchant' + log.C.rs)
  console.log('    ' + log.C.cyan + '9' + log.C.rs + '  ' + log.C.b + log.C.white + 'Config' + log.C.rs + '       ' + log.C.gray + 'show configuration' + log.C.rs)
  console.log()
  console.log('    ' + log.C.cyan + '0' + log.C.rs + '  ' + log.C.b + log.C.white + 'Exit' + log.C.rs + '         ' + log.C.gray + 'close program' + log.C.rs)
  console.log()
}

function menuId() {
  header()
  console.log()
  console.log('  ' + log.C.cyan + log.C.b + 'MENU / INDONESIA' + log.C.rs)
  console.log()
  log.label('PEMBAYARAN')
  console.log('    ' + log.C.cyan + '1' + log.C.rs + '  ' + log.C.b + log.C.white + 'QRIS' + log.C.rs + '         ' + log.C.gray + 'buat QRIS dinamis atau statis' + log.C.rs)
  console.log('    ' + log.C.cyan + '2' + log.C.rs + '  ' + log.C.b + log.C.white + 'Payment Link' + log.C.rs + '  ' + log.C.gray + 'buat link bayar + QR code' + log.C.rs)
  console.log()
  log.label('TRANSAKSI')
  console.log('    ' + log.C.cyan + '3' + log.C.rs + '  ' + log.C.b + log.C.white + 'Status' + log.C.rs + '       ' + log.C.gray + 'cek status transaksi' + log.C.rs)
  console.log('    ' + log.C.cyan + '4' + log.C.rs + '  ' + log.C.b + log.C.white + 'Monitor' + log.C.rs + '      ' + log.C.gray + 'pantau sampai bayar' + log.C.rs)
  console.log('    ' + log.C.cyan + '5' + log.C.rs + '  ' + log.C.b + log.C.white + 'Cancel' + log.C.rs + '       ' + log.C.gray + 'batalkan / expire / refund' + log.C.rs)
  console.log()
  log.label('LAPORAN')
  console.log('    ' + log.C.cyan + '6' + log.C.rs + '  ' + log.C.b + log.C.white + 'Transaksi' + log.C.rs + '     ' + log.C.gray + 'daftar transaksi' + log.C.rs)
  console.log('    ' + log.C.cyan + '7' + log.C.rs + '  ' + log.C.b + log.C.white + 'Saldo' + log.C.rs + '         ' + log.C.gray + 'cek mutasi saldo' + log.C.rs)
  console.log()
  log.label('AKUN')
  console.log('    ' + log.C.cyan + '8' + log.C.rs + '  ' + log.C.b + log.C.white + 'Login' + log.C.rs + '        ' + log.C.gray + 'login GoPay Merchant' + log.C.rs)
  console.log('    ' + log.C.cyan + '9' + log.C.rs + '  ' + log.C.b + log.C.white + 'Config' + log.C.rs + '       ' + log.C.gray + 'lihat konfigurasi' + log.C.rs)
  console.log()
  console.log('    ' + log.C.cyan + '0' + log.C.rs + '  ' + log.C.b + log.C.white + 'Keluar' + log.C.rs + '      ' + log.C.gray + 'tutup program' + log.C.rs)
  console.log()
}

// ─── PERINTAH ───────────────────────────────

async function cmdLogin(args) {
  const gb = new GoBiz()

  if (args[0] === '--otp') {
    const hp = args[1] || await tanya('  Nomor HP (contoh: 62859...): ', true)
    if (!hp) { log.fail('Nomor HP wajib'); return }

    log.step('Kirim OTP ke ' + maskPhone(hp))
    let tokenOtp = await gb.mintaOTP(hp)
    log.ok('OTP terkirim!')
    console.log()

    let kode = null
    while (!kode) {
      log.ln()
      log.label('OTP VERIFICATION')
      log.dim('Kode OTP dikirim ke ' + maskPhone(hp))
      console.log()
      console.log('  ' + log.C.cyan + '1' + log.C.rs + '  ' + log.C.white + 'Masukkan OTP' + log.C.rs + '    ' + log.C.gray + 'masukkan kode OTP' + log.C.rs)
      console.log('  ' + log.C.cyan + '2' + log.C.rs + '  ' + log.C.white + 'Kirim Ulang' + log.C.rs + '   ' + log.C.gray + 'kirim ulang OTP' + log.C.rs)
      console.log('  ' + log.C.cyan + '0' + log.C.rs + '  ' + log.C.white + 'Batal' + log.C.rs + '        ' + log.C.gray + 'batalkan login' + log.C.rs)
      log.ln()
      const pilih = await tanya('  ' + log.C.cyan + '>' + log.C.rs + '  Pilih [0/1/2]: ')

      if (pilih === '1') {
        const input = await tanya('  ' + log.C.cyan + '>' + log.C.rs + '  Kode OTP: ', true)
        if (input && input.length >= 4) {
          kode = input
        } else {
          log.fail('Kode OTP tidak valid')
          console.log()
        }
      } else if (pilih === '2') {
        tokenOtp = await gb.mintaOTP(hp)
        log.ok('OTP dikirim ulang!')
        console.log()
      } else if (pilih === '0') {
        log.info('Dibatalkan')
        return
      } else {
        log.fail('Pilihan tidak valid')
        console.log()
      }
    }

    await gb.loginOTP(hp, tokenOtp, kode)
  } else {
    const email = args[0] || await tanya('  Email: ', true)
    const pass = args[1] || await tanya('  Password: ', true)
    if (!email || !pass) { log.fail('Email dan password wajib'); return }
    await gb.loginEmail(email, pass)
  }

  const user = await gb.ambilProfil()
  const merk = await gb.ambilMerchant()

  log.info('Halo ' + maskName(user.full_name) + ' | ' + mask(user.email))
  log.info('No HP: ' + maskPhone(user.phone))
  log.info('Merchant: ' + merk.merchant_name)

  gb.simpan(FILE_CONFIG, {
    user: { name: user.full_name, email: user.email, phone: user.phone },
    merchant: { name: merk.merchant_name }
  })
  log.ok('Config tersimpan!')
}

async function cmdQRIS(args) {
  // qris static — generate QRIS statis (tanpa nominal, tanpa transaksi)
  if (args[0] === 'static') {
    const cfg = bacaConfig()
    if (!cfg) { log.fail('Belum login'); return }
    try {
      const FILE_STATIC = path.join(__dirname, 'qris_static.json')
      let qrisStatic

      // Pake yg udah disimpen kalo ada
      if (fs.existsSync(FILE_STATIC)) {
        qrisStatic = JSON.parse(fs.readFileSync(FILE_STATIC, 'utf8'))
      } else {
        // Bikin baru lewat Snap, simpan QR string-nya aja (gak dipake transaksi)
        const mid = new Midtrans(cfg.serverKey)
        const snap = await mid.post('https://app.midtrans.com', '/snap/v1/transactions', {
          transaction_details: { order_id: 'QRIS-STATIC-' + Date.now(), gross_amount: 1000 }
        })
        const charge = await mid.post('https://app.midtrans.com', '/snap/v2/transactions/' + snap.token + '/charge', {
          promo_details: null, payment_type: 'other_qris'
        })
        qrisStatic = { qrString: charge.qr_string, qrUrl: charge.qris_url }
        fs.writeFileSync(FILE_STATIC, JSON.stringify(qrisStatic))
        // Cancel transaksi biar gak pending
        await mid.batalkan(charge.order_id).catch(() => {})
      }

      const buf = await QRCode.toBuffer(qrisStatic.qrString, { type: 'png', margin: 2, width: 500 })
      const file = '/tmp/qris_static.png'
      fs.writeFileSync(file, buf)

      if (global.JSON_MODE) return console.log(JSON.stringify(qrisStatic))
      log.ln()
      log.field('QR Image', qrisStatic.qrUrl)
      log.field('File QR', file)
      log.ln()
      log.info('QRIS statis — customer scan + masukin nominal sendiri')
    } catch (e) { log.fail(e.message) }
    return
  }

  let jumlah = parseInt(args[0])
  if (!jumlah || jumlah < 1) {
    const input = await tanya('  Jumlah (Rp): ')
    jumlah = parseInt(input)
    if (!jumlah || jumlah < 1) { log.fail('Jumlah tidak valid'); return }
  }

  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum login. Jalankan: node . login'); return }

  const mid = new Midtrans(cfg.serverKey)
  const id = 'QRIS-' + Date.now()
  const webhook = args[1] || ''

  try {
    const r = await mid.buatQRIS(id, jumlah, webhook || null)
    historyPush({ type: 'qris', id: r.idPesanan, jumlah: r.jumlah, status: r.status })
    if (global.JSON_MODE) {
      return console.log(JSON.stringify(r))
    }
    log.ln()
    log.field('ID Pesanan', r.idPesanan)
    log.field('Jumlah', formatRp(r.jumlah))
    log.field('Status', statusLabel(r.status))
    log.field('Kadaluarsa', r.kadaluarsa)
    log.field('Gambar QR', r.urlGambar)
    log.field('QR String', r.stringQR.substring(0, 60) + '...')
    if (webhook) log.field('Webhook', webhook)

    const fileImg = '/tmp/gopay_qris_' + Date.now() + '.png'
    try {
      const img = await axios.get(r.urlGambar, { responseType: 'arraybuffer', timeout: 5000 })
      fs.writeFileSync(fileImg, Buffer.from(img.data))
      log.field('File QR', fileImg)
    } catch {}
    log.info('Cek status: node . status ' + r.idPesanan)
  } catch (e) {
    log.fail(e.response?.data?.status_message || e.message)
  }
}

async function cmdPayLink(args) {
  let jumlah = parseInt(args[0])
  if (!jumlah || jumlah < 1) {
    const input = await tanya('  Jumlah (Rp): ')
    jumlah = parseInt(input)
    if (!jumlah || jumlah < 1) { log.fail('Jumlah tidak valid'); return }
  }

  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum login'); return }

  const mid = new Midtrans(cfg.serverKey)
  const id = 'PAYLINK-' + Date.now()

  try {
    const r = await mid.buatPaymentLink(id, jumlah)
    log.ln()
    log.field('ID Pesanan', r.idPesanan)
    log.field('Jumlah', formatRp(jumlah))
    log.field('Link Bayar', r.urlBayar)
    log.field('QR Code', r.urlQR)
    log.ln()
    log.info('Share link atau scan QR buat bayar')
  } catch (e) {
    log.fail(e.response?.data?.message || e.message)
  }
}

async function cmdStatus(args) {
  let idPesanan = args[0]
  if (!idPesanan) {
    idPesanan = await tanya('  ID Pesanan: ')
    if (!idPesanan) { log.fail('ID Pesanan wajib'); return }
  }

  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum login'); return }

  const mid = new Midtrans(cfg.serverKey)
  try {
    const s = await mid.cekStatus(idPesanan)
    if (global.JSON_MODE) return console.log(JSON.stringify(s))
    log.ln()
    log.field('Status', statusLabel(s.status))
    log.field('Pembayaran', (s.metode || '').toUpperCase())
    log.field('Jumlah', formatRp(s.jumlah))
    log.field('Penerbit', s.penerbit)
    log.field('Akusitor', s.akuisitor)
    log.field('Fraud', s.fraud)
    log.field('Tipe', s.tipe)
    log.field('Waktu', s.waktu)
    log.ln()
  } catch (e) {
    log.fail(e.response?.data?.status_message || e.message)
  }
}

async function cmdTx(args) {
  const hari = parseInt(args[0]) || 7
  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum login'); return }
  if (!cfg.token) { log.fail('Token tidak tersedia. Login ulang: node . login'); return }

  const gb = new GoBiz()
  gb.token = cfg.token
  gb.idMerchant = cfg.idMerchant

  log.step('Ambil transaksi ' + hari + ' hari terakhir')
  try {
    const daftar = await gb.ambilTransaksi(hari)
    log.ln()
    if (daftar.length === 0) {
      log.info('Tidak ada transaksi')
    } else {
      const ok = daftar.filter(t => t.status === 'success').length
      const fail = daftar.filter(t => t.status === 'failed').length
      const total = daftar.reduce((s, t) => s + t.jumlah, 0)
      log.field('Total', daftar.length + ' transaksi (' + ok + ' sukses, ' + fail + ' gagal)')
      log.field('Volume', formatRp(total))
      log.ln()

      for (const t of daftar.slice(0, 15)) {
        console.log('  ' + statusLabel(t.status) + '  ' + log.C.white + (t.waktu || '').substring(0, 16) + log.C.rs + '  ' + log.C.white + formatRp(t.jumlah).padStart(12) + log.C.rs + '  ' + log.C.gray + (t.metode || '').padEnd(8) + log.C.rs + '  ' + log.C.gray + (t.penerbit || '') + log.C.rs)
      }
      if (daftar.length > 15) {
        log.info('...dan ' + (daftar.length - 15) + ' lainnya')
      }
    }
  } catch (e) {
    if (e.response?.status === 401) {
      log.fail('Sesi habis. Login ulang: node . login <email> <pass>')
    } else {
      log.fail(e.response?.data?.message || e.message)
    }
  }
}

async function cmdBalance() {
  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum login'); return }

  const mid = new Midtrans(cfg.serverKey)
  const akhir = new Date()
  const awal = new Date(akhir.getTime() - 30 * 86400000)

  try {
    const b = await mid.saldo(awal.toISOString(), akhir.toISOString())
    log.ln()
    log.field('Periode', b.start_time + ' s/d ' + b.end_time)
    log.field('Saldo Awal', formatRp(b.opening_balance_effective))
    log.field('Saldo Akhir', formatRp(b.closing_balance_effective))
    log.field('Tertunda', formatRp(b.closing_balance_pending))
    log.ln()
    for (const w of b.wallets || []) {
      log.field('Dompet ' + w.source, formatRp(w.closing_balance_effective))
    }
    log.ln()
  } catch (e) {
    log.fail(e.message)
  }
}

async function cmdCancel() {
  const idPesanan = await tanya('  ID Pesanan: ')
  if (!idPesanan) { log.fail('ID Pesanan wajib'); return }

  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum login'); return }

  const mid = new Midtrans(cfg.serverKey)

  try {
    const info = await mid.cekStatus(idPesanan)
    log.ln()
    log.field('Status saat ini', statusLabel(info.status))
    log.field('Pembayaran', (info.metode || '').toUpperCase())
    log.field('Jumlah', formatRp(info.jumlah))
    log.ln()
  } catch {
    log.warn('Gagal cek status, lanjutkan?')
  }

  log.ln()
  log.label('PILIH AKSI')
  console.log('  ' + log.C.cyan + '1' + log.C.rs + '  ' + log.C.white + 'Cancel' + log.C.rs + '     ' + log.C.gray + 'Batalkan transaksi' + log.C.rs)
  console.log('  ' + log.C.cyan + '2' + log.C.rs + '  ' + log.C.white + 'Expire' + log.C.rs + '     ' + log.C.gray + 'Paksa kadaluwarsa' + log.C.rs)
  console.log('  ' + log.C.cyan + '3' + log.C.rs + '  ' + log.C.white + 'Refund' + log.C.rs + '     ' + log.C.gray + 'Kembalikan dana' + log.C.rs)
  console.log('  ' + log.C.cyan + '0' + log.C.rs + '  ' + log.C.white + 'Batal' + log.C.rs + '      ' + log.C.gray + 'Kembali' + log.C.rs)
  log.ln()
  const pilih = await tanya('  ' + log.C.cyan + '>' + log.C.rs + '  Pilih [0/1/2/3]: ')

  try {
    if (pilih === '1') {
      const konfirm = await tanya('  Yakin cancel ' + idPesanan + '? (y/n): ')
      if (konfirm.toLowerCase() !== 'y') { log.info('Dibatalkan'); return }
      const r = await mid.batalkan(idPesanan)
      log.ok('Status: ' + r.transaction_status)
    } else if (pilih === '2') {
      const konfirm = await tanya('  Yakin expire ' + idPesanan + '? (y/n): ')
      if (konfirm.toLowerCase() !== 'y') { log.info('Dibatalkan'); return }
      const r = await mid.kedaluwarsakan(idPesanan)
      log.ok('Status: ' + r.transaction_status)
    } else if (pilih === '3') {
      const jmlStr = await tanya('  Jumlah refund (Rp): ')
      const jml = parseInt(jmlStr)
      if (!jml || jml < 1) { log.fail('Jumlah tidak valid'); return }
      const konfirm = await tanya('  Yakin refund ' + formatRp(jml) + '? (y/n): ')
      if (konfirm.toLowerCase() !== 'y') { log.info('Dibatalkan'); return }
      const alasan = await tanya('  Alasan (opsional): ')
      const r = await mid.refund(idPesanan, jml, alasan || 'Refund by merchant')
      if (r.transaction_status) log.ok('Status: ' + r.transaction_status)
      else if (r.status_message) log.info(r.status_message)
    } else if (pilih === '0') {
      log.info('Dibatalkan')
    } else {
      log.fail('Pilihan tidak valid')
    }
  } catch (e) {
    log.fail(e.response?.data?.status_message || e.message)
  }
}

async function cmdMonitor(args) {
  const idPesanan = args[0]
  if (!idPesanan) { log.fail('Gunakan: node . monitor <orderId>'); return }

  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum login'); return }

  const mid = new Midtrans(cfg.serverKey)
  log.step('Pantau ' + idPesanan)
  console.log()

  const maxWait = 200
  const spinFrames = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F']
  for (let i = 0; i < maxWait; i++) {
    const pct = (i / maxWait) * 100
    const barW = 25
    const filled = Math.max(1, Math.round((i / maxWait) * barW))
    const fullBar = log.C.cyan + '\u2588'.repeat(filled) + log.C.rs
    const emptyBar = log.C.gray + '\u2591'.repeat(barW - filled) + log.C.rs
    const bar = fullBar + emptyBar
    const spin = spinFrames[i % spinFrames.length]
    process.stdout.write('\r  ' + bar + ' ' + log.C.b + log.C.white + Math.round(pct).toString().padStart(3) + '%' + log.C.rs + ' ' + log.C.cyan + spin + log.C.rs + ' ' + log.C.gray + 'memeriksa...' + log.C.rs + ' ')
    await new Promise(r => setTimeout(r, 3000))
    try {
      const s = await mid.cekStatus(idPesanan, true)
      if (s.status === 'settlement') {
        process.stdout.write('\n\n')
        log.ln()
        log.ok('PEMBAYARAN DITERIMA')
        log.field('Order ID', idPesanan)
        log.field('Status', 'settlement')
        log.field('Jumlah', formatRp(s.jumlah))
        log.field('Penerbit', s.penerbit)
        log.field('Waktu', s.waktu)
        log.ln()
        return
      }
      if (s.status === 'expire' || s.status === 'cancel' || s.status === 'deny') {
        process.stdout.write('\n\n')
        log.fail('Transaksi ' + s.status)
        return
      }
    } catch {}
  }
  process.stdout.write('\n')
  log.fail('Timeout monitoring')
}

async function cmdHistory() {
  const entries = historyList(15)
  if (entries.length === 0) { log.fail('Belum ada history QRIS'); return }
  const stats = historyStats()
  log.ln()
  log.field('Total generate', stats.total + ' QRIS')
  log.field('Total nominal', formatRp(stats.amount))
  log.ln()
  for (const e of entries) {
    const tgl = (e.ts || '').substring(0, 16)
    const rp = formatRp(e.jumlah || 0).padStart(12)
    console.log('  ' + tgl + '  ' + rp + '  ' + e.type + '  ' + e.id)
  }
}

async function cmdSummary() {
  const hist = historyStats()
  log.ln()
  log.field('QRIS via CLI', hist.total + ' kali generate')
  log.field('Total nominal', formatRp(hist.amount))

  const cfg = bacaConfig()
  if (cfg?.token) {
    try {
      const gb = new GoBiz()
      gb.token = cfg.token
      gb.idMerchant = cfg.idMerchant
      const tx = await gb.ambilTransaksi(30)
      const ok = tx.filter(t => t.status === 'success').length
      const vol = tx.reduce((s, t) => s + t.jumlah, 0)
      log.field('Transaksi (30 hari)', tx.length + ' (' + ok + ' sukses)')
      log.field('Volume', formatRp(vol))
    } catch {}
  }
  log.ln()
}

async function cmdConfig() {
  const cfg = bacaConfig()
  if (!cfg) { log.fail('Belum ada config. Jalankan: node . login'); return }

  log.ln()
  log.field('ID Merchant', mask(cfg.idMerchant || '-'))
  log.field('User', (cfg.user?.name ? maskName(cfg.user.name) : '-') + ' | ' + mask(cfg.user?.email || '-'))
  if (cfg.user?.phone) log.field('No HP', maskPhone(cfg.user.phone))
  log.field('Nama Merchant', maskName(cfg.merchant?.name || '-'))
  log.field('Server Key', mask(cfg.serverKey || '-'))
  log.field('Client Key', mask(cfg.clientKey || '-'))
  log.field('Terakhir', cfg.updatedAt || '-')
  log.ln()
}

function bantuan() {
  header()
  const cmds = [
    ['login', '<email> <pass>', 'Login GoPay Merchant'],
    ['login --otp', '<phone>', 'Login via OTP'],
    ['qris', '<amount> [webhook]', 'Generate dynamic QRIS'],
    ['qris static', '', 'Generate static QRIS'],
    ['paylink', '<amount>', 'Create payment link + QR'],
    ['status', '<order_id>', 'Check transaction status'],
    ['monitor', '<order_id>', 'Watch until paid'],
    ['cancel', '<order_id>', 'Cancel transaction'],
    ['expire', '<order_id>', 'Force expire'],
    ['refund', '<id> <amount>', 'Refund transaction'],
    ['balance', '', 'View balance mutation'],
    ['tx', '[days]', 'List transactions'],
    ['listen', '[port]', 'Start webhook server'],
    ['history', '', 'Show QRIS generation history'],
    ['summary', '', 'Show transaction summary'],
    ['config', '', 'Show configuration']
  ]
  log.ln()
  log.label('COMMANDS')
  console.log()
  for (const [cmd, args, desc] of cmds) {
    console.log('  ' + log.C.cyan + log.C.b + cmd + log.C.rs + ' ' + log.C.gray + args + log.C.rs + ' '.repeat(Math.max(1, 18 - cmd.length - args.length)) + log.C.d + desc + log.C.rs)
  }
  console.log()
  log.dim('Append --json to any command for machine-readable output.')
  log.ln()
}

// ─── INTERAKTIF ─────────────────────────────

async function interaktif() {
  if (!global.LANG) {
    // Welcome animation: typewriter text effect on startup
    await new Promise(r => typewrite('GoPay Merchant CLI v2.0', r))
    await new Promise(r => typewrite('QRIS  Paylink  Refund  Webhook  Balance', r))

    // Show ASCII art header before language prompt
    header()

    // Language prompt
    const lang = await tanya('  ' + log.C.cyan + '?' + log.C.rs + ' Language? (en/id): ')
    global.LANG = lang === 'id' ? 'id' : 'en'
  }

  if (global.LANG === 'id') menuId()
  else menu()

  const p = await tanya('  ' + log.C.gray + '|' + log.C.rs + ' ' + log.C.cyan + '>' + log.C.rs + ' ')

  switch (p) {
    case '1': await cmdQRIS([]); break
    case '2': await cmdPayLink([]); break
    case '3': await cmdStatus([]); break
    case '4': await cmdMonitor([]); break
    case '5': await cmdCancel(); break
    case '6': await cmdTx([]); break
    case '7': await cmdBalance(); break
    case '8': await cmdLogin([]); break
    case '9': await cmdConfig(); break
    case '0':
      console.log()
      console.log('  ' + log.C.cyan + '\u2728' + log.C.rs + '  ' + (global.LANG === 'id' ? 'Sampai jumpa!' : 'Goodbye!') + '  ' + log.C.cyan + '\u2728' + log.C.rs + '  ')
      process.exit(0)
      break
    default: log.fail(global.LANG === 'id' ? 'Pilihan tidak ada' : 'Invalid option'); break
  }

  console.log()
  const lagi = await tanya('  ' + log.C.cyan + '?' + log.C.rs + ' ' + (global.LANG === 'id' ? 'Kembali ke menu? (y/n): ' : 'Back to menu? (y/n): '))
  if (lagi.toLowerCase() === 'y' || lagi === '') return interaktif()
  console.log()
  console.log('  ' + log.C.cyan + '\u2728' + log.C.rs + '  ' + (global.LANG === 'id' ? 'Sampai jumpa!' : 'Goodbye!') + '  ' + log.C.cyan + '\u2728' + log.C.rs + '  ')
  console.log()
}

// ─── MAIN ───────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const jsonIdx = args.indexOf('--json')
  global.JSON_MODE = jsonIdx !== -1
  if (jsonIdx !== -1) args.splice(jsonIdx, 1)

  const cmd = args[0]
  const cmdArgs = args.slice(1)

  try {
    if (!cmd) {
      await interaktif()
      return
    }

    switch (cmd) {
      case 'login':   await cmdLogin(cmdArgs); break
      case 'qris':    await cmdQRIS(cmdArgs); break
      case 'paylink': await cmdPayLink(cmdArgs); break
      case 'status':  await cmdStatus(cmdArgs); break
      case 'monitor': await cmdMonitor(cmdArgs); break
      case 'history': await cmdHistory(); break
      case 'summary': await cmdSummary(); break
      case 'cancel':  {
        const oid = cmdArgs[0]
        if (!oid) { log.fail('Gunakan: node . cancel <id>'); return }
        const cfg = bacaConfig()
        if (!cfg) { log.fail('Belum login'); return }
        const mid = new Midtrans(cfg.serverKey)
        const konfirm = await tanya('  Yakin cancel ' + oid + '? (y/n): ')
        if (konfirm.toLowerCase() !== 'y') { log.info('Dibatalkan'); return }
        const r = await mid.batalkan(oid)
        if (global.JSON_MODE) return console.log(JSON.stringify(r))
        log.ok('Status: ' + r.transaction_status)
        break
      }
      case 'expire':  {
        const oid = cmdArgs[0]
        if (!oid) { log.fail('Gunakan: node . expire <id>'); return }
        const cfg = bacaConfig()
        if (!cfg) { log.fail('Belum login'); return }
        const mid = new Midtrans(cfg.serverKey)
        const konfirm = await tanya('  Yakin expire ' + oid + '? (y/n): ')
        if (konfirm.toLowerCase() !== 'y') { log.info('Dibatalkan'); return }
        const r = await mid.kedaluwarsakan(oid)
        if (global.JSON_MODE) return console.log(JSON.stringify(r))
        log.ok('Status: ' + r.transaction_status)
        break
      }
      case 'refund':  {
        const oid = cmdArgs[0]
        const jml = parseInt(cmdArgs[1])
        if (!oid || !jml) { log.fail('Gunakan: node . refund <id> <jumlah>'); return }
        const cfg = bacaConfig()
        if (!cfg) { log.fail('Belum login'); return }
        const mid = new Midtrans(cfg.serverKey)
        const konfirm = await tanya('  Yakin refund ' + oid + ' ' + formatRp(jml) + '? (y/n): ')
        if (konfirm.toLowerCase() !== 'y') { log.info('Dibatalkan'); return }
        const r = await mid.refund(oid, jml, cmdArgs[2] || 'Refund by merchant')
        if (global.JSON_MODE) return console.log(JSON.stringify(r))
        if (r.transaction_status) log.ok('Status: ' + r.transaction_status)
        else if (r.status_message) log.info(r.status_message)
        break
      }
      case 'balance': await cmdBalance(); break
      case 'tx':      await cmdTx(cmdArgs); break
      case 'config':  await cmdConfig(); break
      case 'listen': {
        const port = parseInt(cmdArgs[0]) || 3000
        const cfg = bacaConfig()
        const serverKey = cfg?.serverKey || ''
        log.step('Webhook listener di port ' + port)
        log.info('Kirim notifikasi Midtrans ke: http://ipkamu:' + port + '/webhook')
        log.info('(Pake ngrok kalo mau diakses internet: ngrok http ' + port + ')')
        log.ln()
        http.createServer((req, res) => {
          let body = ''
          req.on('data', c => body += c)
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const oid = data.order_id || '-'
              const status = data.transaction_status || '-'
              const amount = data.gross_amount || '-'
              const method = data.payment_type || '-'
              const issuer = data.issuer || '-'

              // Verify signature
              const sigKey = data.signature_key
              if (sigKey && serverKey) {
                const hash = crypto.createHash('sha512')
                  .update(oid + data.status_code + amount + serverKey)
                  .digest('hex')
                const valid = hash === sigKey
                if (!valid) log.warn('Signature TIDAK valid! Mungkin bukan dari Midtrans')
              }

              log.ln()
              log.field('Notifikasi diterima!', '')
              log.field('Order ID', oid)
              log.field('Status', status)
              log.field('Jumlah', formatRp(Number(amount)))
              log.field('Metode', method.toUpperCase())
              log.field('Penerbit', issuer)
              if (data.settlement_time) log.field('Settlement', data.settlement_time)
              log.ln()

              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
            } catch {
              res.writeHead(400)
              res.end('invalid json')
            }
          })
        }).listen(port)
        log.ok('Server jalan di http://0.0.0.0:' + port)
        break
      }
      default:        bantuan()
    }
  } catch (e) {
    const pesan = e.response?.data?.errors?.[0]?.message || e.response?.data?.status_message || e.response?.data?.message || e.message
    log.fail(pesan)
  }
}

main()
