<p align="center">
  <img src="logo.png" alt="GoPay Merchant CLI" width="100">
</p>

<h1 align="center">GoPay Merchant CLI</h1>

<p align="center">
  CLI untuk menerima pembayaran QRIS dari terminal.<br>
  Didukung Midtrans Snap API. Dibayar via DANA, GoPay, OVO, ShopeePay, LinkAja.
</p>

<br>

---

## Tentang

GoPay Merchant CLI adalah tool terminal yang memungkinkan merchant menerima pembayaran QRIS secara instan. Jalankan satu perintah, QRIS langsung tergenerate — customer scan dan bayar.

Tool ini berguna untuk developer yang perlu integrasi QRIS ke POS, e-commerce, bot Telegram/WhatsApp, atau sistem pembayaran otomatis lainnya.

---

## Instalasi

```bash
git clone https://github.com/IbraDecode/gopaymerchant.git
cd gopaymerchant
npm install
```

Butuh Node.js 18+. Jalan di Linux, macOS, Windows (via WSL/Git Bash).

---

## Menjalankan Aplikasi

Tanpa argumen, tool akan masuk ke menu interaktif:

```bash
node .
```

Atau jalankan perintah langsung:

```bash
node . login you@email.com yourpassword
```

---

## Login

Sebelum bisa generate QRIS, tool perlu terhubung dengan akun merchant. Jalankan:

```bash
node . login you@email.com yourpassword
```

Perintah ini akan login, mengambil konfigurasi payment gateway, lalu menyimpannya ke `config.json`.

Alternatif, bisa pake OTP kalo lupa password:

```bash
node . login --otp 6281234567890
```

Atau langsung set Server Key via environment variable:

```bash
export GOPAY_SERVER_KEY="Mid-server-xxx"
```

---

## Generate QRIS

Setelah login, QRIS bisa langsung digenerate.

QRIS dinamis — nominal sudah termasuk di dalam QR. Customer scan langsung bayar.

```bash
node . qris 50000
```

<div align="center">
  <img src="getting-started.gif" alt="Generate QRIS" width="720">
</div>

**Flow:**

```
Generate QRIS  →  Customer scan pake DANA/GoPay/OVO/dll
      ↓
Midtrans proses pembayaran
      ↓
Status berubah jadi "settlement"
```

QRIS juga otomatis disimpan ke `/tmp/gopay_qris_*.png`.

QRIS statis — tanpa nominal, customer isi sendiri:

```bash
node . qris static
```

QRIS + webhook — dapet notifikasi pas dibayar:

```bash
node . qris 50000 https://serverlo.com/webhook
```

---

## Customer Melakukan Pembayaran

Customer scan QRIS pake aplikasi dompet digital atau mobile banking yang support QRIS.

Setelah bayar, status transaksi otomatis berubah dari `pending` jadi `settlement`. Merchant bisa ngecek status kapan aja.

---

## Cek Status Transaksi

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

Bisa juga pantau real-time dengan progress bar:

```bash
node . monitor QRIS-1783336749362
```

Tool akan berhenti otomatis begitu status berubah jadi `settlement`, `expire`, `cancel`, atau `deny`.

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

## Refund

Refund transaksi yang sudah settlement. Dana dikembalikan ke sumber pembayaran customer.

```bash
node . refund QRIS-1783336749362 50000
```

<div align="center">
  <img src="refund.gif" alt="Refund" width="600">
</div>

**Flow refund:**

```
Cek status transaksi  →  Status "settlement"
        ↓
Jalankan refund      →  node . refund QRIS-xxx 50000
        ↓
Dana dikembalikan    →  Status berubah jadi "refund"
```

---

## Webhook

Webhook server untuk menerima notifikasi pembayaran secara real-time. Cocok dipasang di server backend.

```bash
node . listen 3000
```

Server akan menerima POST di `/webhook`. Setiap notifikasi diverifikasi signature-nya menggunakan SHA-512 — memastikan notifikasi benar-benar dari Midtrans.

Kombinasikan dengan QRIS:

```bash
node . qris 50000 https://serverlo.com:3000/webhook
```

<div align="center">
  <img src="qris-payment-flow.gif" alt="Payment Flow" width="720">
</div>

Payload notifikasi yang dikirim Midtrans:

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

## Balance

Cek mutasi saldo 30 hari terakhir:

```bash
node . balance
```

Output:

```
  Periode    : 2026-06-06 s/d 2026-07-06
  Saldo Awal : Rp 1.081
  Saldo Akhir: Rp 501
```

Berguna untuk rekonsiliasi pembayaran.

---

## Daftar Perintah

| Perintah | Argumen | Keterangan |
|----------|---------|-----------|
| `login` | `<email> <password>` | Login akun merchant |
| `login --otp` | `<phone>` | Login via OTP |
| `qris` | `<amount> [webhook_url]` | Generate QRIS dinamis |
| `qris static` | — | QRIS statis (tanpa nominal) |
| `paylink` | `<amount>` | Payment link + QR code |
| `status` | `<order_id>` | Cek status transaksi |
| `monitor` | `<order_id>` | Pantau sampai settlement |
| `cancel` | `<order_id>` | Batalkan transaksi |
| `expire` | `<order_id>` | Paksa expire |
| `refund` | `<order_id> <amount>` | Refund transaksi |
| `balance` | — | Mutasi saldo 30 hari |
| `tx` | `[days]` | Riwayat transaksi |
| `listen` | `[port]` | Webhook server (default 3000) |
| `config` | — | Lihat konfigurasi |

Semua perintah bisa ditambah `--json` untuk output JSON.

---

## Konfigurasi

Konfigurasi disimpan di `config.json`. File ini otomatis diabaikan oleh git.

Untuk production, disarankan pake environment variable:

```bash
export GOPAY_SERVER_KEY="Mid-server-xxx"
```

---

## FAQ

**Q: Apa bedanya QRIS sama Payment Link?**  
A: QRIS buat scan langsung (POS/tatap muka). Payment Link buat dishare via chat/email dan punya halaman bayar sendiri.

**Q: Bisa dipake production?**  
A: Udah diuji dengan transaksi real. Semua fitur (QRIS, refund, webhook) berfungsi.

**Q: Butuh akun merchant?**  
A: Iya. Tapi pendaftarannya gratis melalui aplikasi GoBiz.

**Q: Ada contoh output JSON?**  
A: Semua perintah support `--json`. Contoh: `node . qris 50000 --json` akan output JSON, bukan teks.

---

<br>

<p align="center">
  <a href="https://t.me/ibracode">t.me/ibracode</a>
  <br><br>
  <sub>&copy; 2026 Ibra Ramdan</sub>
</p>
