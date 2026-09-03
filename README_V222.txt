BingX Paper Bot V2.22 — Setup / Trigger / Execution Scoring

V2.22 düzeltmeleri:
- Setup Quality artık yapının kalitesini; Trigger Readiness tetik yakınlığını; Execution Score yalnız gerçek tetik/retest sonrası işlem kalitesini gösterir.
- PRE_BREAKOUT artık yüksek Setup puanı alsa bile tetiklenmiş işlem gibi görünmez.
- Public statüler: HAZIRLANIYOR -> ARMED -> TETİKLENDİ -> RETEST; aşırı uzamış hareket KAÇTI / KOVALAMA.
- ARMED: sınır yaklaşık %1.5 içinde, Setup >=8/10 ve en az 3 boundary testi şartı.
- Boundary test kalitesi: 2 test ZAYIF, 3 test KABUL, 4+ test PREMIUM.
- 3 testli PRE_BREAKOUT Setup Quality en fazla 9.0; 2 testli en fazla 8.25. Böylece 3 testli hazırlık 9.75/10 gibi premium görünmez.
- Breakout hacmi artık Setup Quality'yi şişirmek yerine esas olarak Execution Score'u güçlendirir.
- ADR20 / ATR20 karşılaştırması volatilite sanity-check olarak eklendi: NORMAL / YÜKSEK / AGRESİF. ATR'nin ADR'ye göre aşırı yüksek olması skorları düşürür.
- Gerçek PAPER sinyali yalnız BREAKOUT_CONFIRMED / RETEST / CONTINUATION_BREAKOUT ve Execution Score >=7.25 olduğunda geçer.
- HAZIRLANIYOR/ARMED bildirimlerinde açıkça ŞİMDİ GİRİŞ YOK ve eksik teyit yazılır.
- TETİKLENDİ bildirimlerinde Setup ve Execution ayrı gösterilir.
- Mevcut Durable Object / paper kayıtları korunur; Worker adı yine bingx-paper-bot'tur.

Örnek sentetik doğrulama:
- 3 test, sınır %2.06 uzakta: HAZIRLANIYOR, Setup 8.50, Tetik 5.75, Execution yok.
- 3 test, sınır %1.19 uzakta: ARMED, Setup 8.75, Tetik 6.00, Execution yok.
- 4 test, kalıcı breakdown + hacim: TETİKLENDİ, Setup 9.25, Execution 9.00.

Dosyalar:
- worker_top100_v221_scoring_status.js -> ana Worker
- belit_daily_v221.js                 -> V2.22 Belit-style pattern/scoring motoru
- worker_top100_v217_usd_sign_fix.js  -> mevcut kanıtlanmış BingX execution/paper tabanı
- wrangler.jsonc                      -> main V2.22'e ayarlı

Kontrol:
- Node syntax/import kontrolü geçti.
- PRE_BREAKOUT / ARMED / TETİKLENDİ sentetik testleri geçti.

Not:
- Sistem PAPER/TEST mantığını korur. Gerçek işlem otomasyonu eklenmedi.


V2.22 TELEGRAM DAVRANIŞI
- HAZIRLANIYOR / ARMED / erken uyarılar Telegram'a gönderilmez.
- Erken uyarılar web sitesindeki radar ve JSON çıktısında görünmeye devam eder.
- Telegram yalnızca gerçek tetiklenmiş LONG veya SHORT sinyallerini gönderir.
- PAPER mantığı ve gerçek işlem otomasyonu değişmedi; gerçek emir otomasyonu yoktur.
