BingX Paper Bot V2.24 — Fast Liquid + Dynamic Margin

PAPER/TEST ONLY
- EXECUTION_MODE worker içinde TEST'e zorlanır. Gerçek emir göndermez.
- Yalnız BingX USDⓢ-M perpetual verileri kullanılır.

Tarama mimarisi
- Top100 likit BingX USDT perpetual evreni korunur.
- Rotating shard 10 coin/dk: Top100 yaklaşık 10 dakikada bir tamamen yeniden görülür.
- Hacme göre ilk 10 likit perpetual her dakika hızlı şeritte taranır.
- CORE5 (BTC/ETH/SOL/XRP/DOGE) ilk 10 dışında kalsa bile her dakika garanti taranır.
- Tüm evrenden en iyi 5 HAZIRLANIYOR/ARMED aday ayrıca her dakika hızlı takip edilir.
- Son 6 kapanmış 15dk mum ile intraday boundary breakout/retest/kaçmış kontrolü sürer.

Dinamik PAPER margin
- 7.5–7.9 Execution: 5–7 USDT (puan yükseldikçe kademeli)
- 8.0–8.5: 10 USDT
- 9.0+: 15 USDT
- 5x isolated. Legacy kayıtların eski 20 USDT PnL hesabı korunur; yeni V2.24 işlemler kendi margin değeriyle hesaplanır.
- V2.24 yeni işlemler scannerVersion, scoreBand, qualityScore ve paperMarginUSDT ile kaydedilir.

Bildirim
- Telegram yalnız gerçek TETİKLENDİ/RETEST PAPER LONG/SHORT sinyallerini gönderir.
- HAZIRLANIYOR/ARMED adaylar web radarında kalır; maksimum 5 hızlı watch adayı.

Dosyalar
- worker_top100_v224_fast_trigger.js
- worker_top100_v224_fast_base.js
- belit_daily_v224.js
- wrangler.jsonc
