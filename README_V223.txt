BingX Paper Bot V2.23 — Fast 15m Trigger Follow-up (PAPER/TEST ONLY)

V2.23 amacı:
- ETH 2.500 benzeri, günlük boundary çevresinde 15dk içinde oluşan kırılımları bir sonraki geniş tarama turuna bırakmamak.
- Giriş filtresini gevşetmeden daha hızlı doğrulamak.

Değişiklikler:
- Cloudflare Cron yine her dakika: * * * * *
- Top100 geniş tarama 8'li shard yapısını korur.
- CORE5 (BTC/ETH/SOL/XRP/DOGE) her dakika ayrıca taranır.
- Global hızlı takip listesinde en fazla 5 güçlü ERKEN UYARI adayı Durable Object içinde tutulur ve her dakika yeniden taranır.
- Erken uyarı hızlı listeye girebilmek için boundary yaklaşık <=0.5 adet 15dk ATR uzakta, 4s+1s+15dk yön uyumlu, EMA200 uyumlu ve hacim >=1.05x olmalıdır.
- Günlük boundary yanında son 6 KAPANMIŞ 15dk mum izlenir. Boundary cross + Last/Mark kabulü varsa INTRADAY_BREAKOUT_CONFIRMED üretilebilir.
- İlk sağlıklı 15dk retest için INTRADAY_RETEST eklendi.
- Kırılım sonrası fiyat boundary'den >1.5 adet 15dk ATR uzaklaşırsa KAÇMIŞ/KOVALAMA filtresi devreye girer.
- Last Price BingX ticker'dan, Mark Price + funding BingX premiumIndex'ten alınır. Last/Mark giriş geçerliliği kontrol edilir.
- Incomplete 15dk mum yerine kapanmış 15dk mumlar tetik hesaplarında kullanılır.
- Execution eşiği 7.5/10. Web radarında en fazla 5 hızlı watch adayı tutulur; Telegram V2.22 gibi yalnız gerçek tetiklenmiş LONG/SHORT PAPER sinyallerini gönderir.
- Worker fallback execution yolu zorla EXECUTION_MODE=TEST ile çağrılır. Bu paket gerçek emir göndermez.

Dosyalar:
- worker_top100_v223_fast_trigger.js
- belit_daily_v223.js
- worker_top100_v223_fast_base.js
- wrangler.jsonc

Not:
- Mevcut PAPER Durable Object kayıtları korunur.
- Bu sürüm gerçek para için değildir. Kullanıcı açıkça “gerçek paraya geçiyoruz” demedikçe TEST kilidi kaldırılmamalıdır.
