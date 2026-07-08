const C = {
  rs: '\x1b[0m',
  b: '\x1b[1m',
  d: '\x1b[2m',
  cyan: '\x1b[96m',
  green: '\x1b[92m',
  red: '\x1b[91m',
  yellow: '\x1b[93m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
}

function ts() {
  return C.gray + new Date().toLocaleTimeString('id-ID', { hour12: false }) + C.rs
}

function badge(label, color, msg) {
  if (global.JSON_MODE) return
  console.log(ts() + ' ' + color + C.b + '[' + label + ']' + C.rs + ' ' + msg)
}

module.exports = {
  ok:     (m) => badge('OK', C.green, m),
  fail:   (m) => badge('FAIL', C.red, m),
  info:   (m) => badge('INFO', C.cyan, m),
  warn:   (m) => badge('WARN', C.yellow, m),
  step:   (m) => { if (!global.JSON_MODE) console.log('\n' + C.cyan + '> ' + C.b + m + C.rs) },
  sp:     () => console.log(),
  ln:     () => console.log(C.gray + '-'.repeat(40) + C.rs),
  field:  (l, v) => console.log('  ' + C.green + l + ': ' + C.rs + C.white + (v ?? '-') + C.rs),
  label:  (t) => console.log('  ' + C.cyan + C.b + '* ' + t + C.rs),
  dim:    (t) => console.log('  ' + C.gray + t + C.rs),
  raw:    console.log,
  C
}
