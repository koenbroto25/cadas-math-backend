'use strict';

/**
 * id-math-synonyms.js — Base synonym map untuk operasi matematika SD
 * Kata kunci bahasa Indonesia → operator matematika.
 * Diperkaya saat startup oleh corpus-vocab-builder.js dari DB exercises.
 */

// OP_SYNONYMS: stem/kata → operator matematika
const OP_SYNONYMS = {
  // Penjumlahan
  'tambah': '+', 'menambah': '+', 'ditambah': '+', 'penambahan': '+',
  'jumlah': '+', 'total': '+', 'seluruh': '+', 'gabung': '+', 'kumpul': '+',
  'menjumlah': '+', 'bersama': '+', 'bertambah': '+', 'naik': '+',
  'jumlahkan': '+', 'totalkan': '+', 'menggabung': '+', 'mengumpulkan': '+',
  'ditambahkan': '+', 'bertemu': '+', 'membeli': '+', 'beli': '+',
  // Pengurangan
  'kurang': '-', 'dikurang': '-', 'berkurang': '-', 'mengurang': '-',
  'sisa': '-', 'sisanya': '-', 'tinggal': '-', 'ambil': '-', 'pakai': '-',
  'hilang': '-', 'pergi': '-', 'turun': '-', 'habis': '-', 'belanja': '-',
  'dikurangi': '-', 'mengurangi': '-', 'pengurangan': '-', 'selisih': '-',
  'diambil': '-', 'dipakai': '-', 'digunakan': '-', 'tersisa': '-',
  // Perkalian
  'kali': '*', 'dikali': '*', 'berlipat': '*', 'lipat': '*',
  'sebanyak': '*', 'tiap': '*', 'setiap': '*', 'masing': '*',
  'perkalian': '*', 'mengalikan': '*', 'dikalikan': '*', 'kelipatan': '*',
  // Pembagian
  'bagi': '/', 'dibagi': '/', 'membagi': '/', 'membagikan': '/',
  'rata': '/', 'bagian': '/', 'perbagian': '/', 'per': '/',
  'pembagian': '/', 'dibagikan': '/', 'berbagi': '/', 'merata': '/',
  // Pecahan / persen
  'setengah': 'frac', 'seperempat': 'frac', 'sepertiga': 'frac',
  'persen': 'pct', 'diskon': 'pct', 'pajak': 'pct', 'potongan': 'pct',
};

// NAMA_ORANG: nama umum di soal cerita SD Indonesia
const NAMA_ORANG = new Set([
  'budi','siti','ani','andi','dani','reza','lina','dina','beni','tono',
  'ayu','rina','dewi','agus','yudi','hana','bagas','cici','doni','eka',
  'fani','gilang','hendra','indah','joko','kiki','lia','mita','nana',
  'oki','pipit','qori','rini','sari','tika','una','vira','wati','xena',
  'yanti','zara','alex','bella','cinta','desi','erna','fatma','gita',
  'ibu','ayah','kakak','adik','nenek','kakek','paman','bibi','pak','bu',
]);

// BENDA_UMUM: benda konteks soal cerita SD
const BENDA_UMUM = new Set([
  'kelereng','permen','pensil','krayon','roti','kue','ember','keranjang',
  'apel','jeruk','mangga','bola','buku','spidol','penggaris','tas',
  'sepatu','kaos','celana','topi','sendok','piring','gelas','botol',
  'bunga','pohon','ikan','ayam','sapi','kambing','bebek','kucing',
  'uang','koin','rupiah','tiket','lembar','bungkus','kantong','kotak',
  'potong','iris','bagian','lusin','kodi','gross','rim','pak','karton',
  'meter','liter','kilogram','gram','kilometer','sentimeter',
]);

module.exports = { OP_SYNONYMS, NAMA_ORANG, BENDA_UMUM };
