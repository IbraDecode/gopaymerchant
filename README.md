<p align="center">
  <img src="logo.png" alt="GoPay Merchant CLI" width="100">
</p>

<h1 align="center">GoPay Merchant CLI</h1>

<p align="center">
  CLI untuk generate QRIS, kelola pembayaran, refund, dan webhook.<br>
  Menggunakan Midtrans Snap API. Bisa dibayar pake DANA, GoPay, OVO, ShopeePay, LinkAja.
</p>

<br>

---

## Gambaran Project

GoPay Merchant CLI adalah tool terminal yang memungkinkan merchant menerima pembayaran QRIS secara instan. Cukup jalankan satu perintah, QRIS langsung tergenerate — customer scan dan bayar.

Tool ini berguna untuk:
- Developer yang perlu integrasi QRIS ke POS / e-commerce / bot
- Merchant yang butuh generate QRIS dinamis tanpa dashboard
- Siapa saja yang butuh payment gateway dari terminal

---

## Fitur

**QRIS Dinamis** — Generate QR dengan nominal langsung. Customer scan & bayar.

**QRIS Statis** — QR tetap tanpa nominal, customer isi sendiri jumlahnya.

**Payment Link** — Link bayar + QR code otomatis. Cocok dishare via WA, email, invoice.

**Refund** — Refund transaksi settlement langsung dari terminal.

**Webhook Server** — Listener notifikasi pembayaran real-time + verifikasi signature SHA-512.

**Monitor** — Pantau transaksi dengan progress bar, auto-detect settlement.

**Cek Saldo** — Lihat mutasi saldo 30 hari terakhir.

**JSON Mode** — Semua perintah support `--json` buat integrasi dengan script lain.

---

## Instalasi

```bash
git clone https://github.com/IbraDecode/gopaymerchant.git
cd gopaymerchant
npm install
```

Butuh Node.js 18+. Jalan di Linux, macOS, Windows (via WSL/Git Bash).

---

## Getting Started

<div align="center">
  <img src="getting-started.gif" alt="Getting Started" width="720">
</div>

Setelah instalasi, jalankan perintah login untuk menghubungkan tool dengan akun merchant:

```bash
node . login you@email.com yourpassword
```

Perintah ini akan:
1. Login ke akun merchant
2. Mengambil konfigurasi payment gateway
3. Menyimpan ke file `config.json`

Setelah login, QRIS bisa langsung digenerate.

---

## Generate QRIS

QRIS dinamis — nominal sudah termasuk di dalam QR. Customer scan langsung bayar, tanpa perlu isi nominal.

```bash
node . qris 50000
```

Output:

```
  ID Pesanan : QRIS-1783336749362
  Jumlah     : Rp 50.000
  Status     : pending
  Kadaluarsa : 2026-07-06 20:25
  Gambar QR  : https://.../qr-code
```

QR juga otomatis disimpan ke `/tmp/gopay_qris_*.png`.

QRIS statis — tanpa nominal, customer isi sendiri:

```bash
node . qris static
```

QRIS + webhook — dapet notifikasi pas dibayar:

```bash
node . qris 50000 https://serverlo.com/webhook
```

---

## Payment Link

Buat link bayar yang bisa dishare via WhatsApp, email, atau social media. Setiap link punya QR code sendiri.

```bash
node . paylink 50000
```

```
  ID Pesanan : PAYLINK-1783342107764
  Link Bayar : https://app.midtrans.com/payment-links/...
  QR Code    : https://api.midtrans.com/v1/payment-links/.../qr-code
```

Link berlaku 60 menit, sekali pakai.

---

## Status Transaksi

Cek status transaksi berdasarkan Order ID:

```bash
node . status QRIS-1783336749362
```

Output:

```
  Status     : settlement
  Pembayaran : QRIS
  Jumlah     : Rp 50.000
  Penerbit   : dana
  Waktu      : 2026-07-06 19:21:32
```

Status yang mungkin: `pending`, `settlement` (lunas), `cancel`, `expire`, `refund`, `deny`.

---

## Refund

<div align="center">
  <img src="refund.gif" alt="Refund" width="600">
</div>

Refund transaksi yang sudah settlement:

```bash
node . refund QRIS-1783336749362 50000
```

Refund diproses secara online, dana dikembalikan ke sumber pembayaran customer.

---

## Monitor

Pantau transaksi sampai lunas:

```bash
node . monitor QRIS-1783336749362
```

Progress bar akan berjalan, dan tool akan berhenti otomatis begitu status berubah jadi `settlement`, `expire`, `cancel`, atau `deny`.

---

## Webhook

<div align="center">
  <img src="qris-payment-flow.gif" alt="Payment Flow" width="720">
</div>

Tool ini punya webhook server built-in untuk menerima notifikasi pembayaran real-time:

```bash
node . listen 3000
```

Server akan menerima POST di `/webhook`. Setiap notifikasi diverifikasi signature-nya pake SHA-512.

Kombinasikan dengan QRIS:

```bash
node . qris 50000 https://serverlo.com:3000/webhook
```

Payload notifikasi:

```json
{
  "transaction_status": "settlement",
  "payment_type": "qris",
  "order_id": "QRIS-1783336749362",
  "gross_amount": "50000.00",
  "issuer": "dana"
}
```

---

## Daftar Perintah

| Perintah | Argumen | Keterangan |
|----------|---------|-----------|
| `login` | `<email> <password>` | Login akun merchant |
| `login --otp` | `<phone>` | Login via OTP |
| `qris` | `<amount> [webhook_url]` | Generate QRIS dinamis |
| `qris static` | — | QRIS statis |
| `paylink` | `<amount>` | Payment link + QR code |
| `status` | `<order_id>` | Cek status transaksi |
| `monitor` | `<order_id>` | Pantau sampai settlement |
| `cancel` | `<order_id>` | Batalkan transaksi |
| `expire` | `<order_id>` | Paksa expire |
| `refund` | `<order_id> <amount>` | Refund transaksi |
| `balance` | — | Cek mutasi saldo 30 hari |
| `tx` | `[days]` | Riwayat transaksi |
| `listen` | `[port]` | Webhook server |
| `config` | — | Lihat konfigurasi |

Semua perintah bisa ditambah `--json` untuk output JSON.

---

## Konfigurasi

Konfigurasi disimpan di `config.json` (otomatis di-`.gitignore`). Alternatifnya, bisa pake environment variable:

```bash
export GOPAY_SERVER_KEY="Mid-server-xxx"
```

Environment variable lebih disarankan untuk production.

---

## FAQ

**Q: Apa bedanya QRIS sama Payment Link?**  
A: QRIS buat scan langsung (POS/tatap muka). Payment Link buat dishare via chat/email.

**Q: Bisa dipake production?**  
A: Udah diuji dengan transaksi real. Semua fitur (QRIS, refund, webhook) berfungsi.

**Q: Butuh akun merchant?**  
A: Iya. Tapi pendaftarannya gratis.

**Q: Gimana cara dapetin source code lengkap?**  
A: Hubungi kontak di bawah.

---

<p align="center">
  <br><br>
  <a href="https://t.me/ibracode">t.me/ibracode</a>
  <br><br>
  <sub>&copy; 2026 Ibra Ramdan</sub>
</p>
