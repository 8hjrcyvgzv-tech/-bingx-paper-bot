BingX Paper Bot V2.20 — Belit Breakout Katmanı

Yeni eklenenler:
- 1G tekrar-test edilmiş yatay sınır kümeleri (tek spike yerine seviye kümeleri)
- PRE_BREAKOUT / HAZIRLANIYOR erken uyarısı
- Kalıcı breakout: iki tamamlanmış 1G kapanış ile teyit mantığı
- RETEST ve CONTINUATION_PREP / CONTINUATION_BREAKOUT ayrımı
- Setup Quality ve Entry Quality ayrı skorları
- SMA 10/20/50/100/200 günlük rejim değerlendirmesi
- ADR20 ve ATR20 günlük volatilite sanity-check
- EXTENDED / KAÇMIŞ filtresi: ATR bazlı aşırı uzamış hareketi kovalamaz
- CORE5 etiketi: BTC, ETH, SOL, XRP, DOGE; diğerleri GENİŞ TARAMA
- Her tarama turunda en iyi en fazla 2 PAPER giriş ve en fazla 2 erken uyarı
- Erken uyarı cooldown: 4 saat; giriş alarm cooldown: 1 saat
- Yeni V2.20 paper işlemlerine setupQuality, entryQuality, belitStage, boundary ve ADR/ATR etiketleri kaydedilir
- Mevcut V2.19/V2.18 paper kayıtları silinmez; mevcut Durable Object yapısı korunur

Dosyalar:
- worker_top100_v220_belit_breakout.js  -> ana Worker
- belit_daily_v220.js                  -> günlük Belit-style pattern motoru
- worker_top100_v217_usd_sign_fix.js   -> mevcut kanıtlanmış BingX execution/paper tabanı
- wrangler.jsonc                       -> main V2.20'ye ayarlı

Test:
- Node syntax check geçti.
- Sentetik senaryolarda PRE_BREAKOUT, BREAKOUT_CONFIRMED ve EXTENDED/KAÇMIŞ sınıfları doğrulandı.

Not:
- Sistem PAPER/TEST mantığını korur. Gerçek işlem köprüsü değiştirilmedi.
