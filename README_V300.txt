V3.1 WIDE DISCOVERY + EMRE + AKSEL + BELIT CONSENSUS

PAPER/TEST ONLY. Worker, EXECUTION_MODE değerini zorla TEST yapar. Kullanıcı açıkça “gerçek paraya geçiyoruz” demeden gerçek emir açılamaz.

NEDEN V3.1?
- Top100 hard cutoff kaldırıldı. Bot artık BingX USDⓢ-M perpetual evreninde 24s quote volume >= 1.5M USDT olan pariteleri aday havuzuna alır.
- Ticker bid/ask alanları mevcutsa spread > %0.45 olanlar daha baştan elenir.
- En likit 10 + CORE5 her dakika; en iyi 5 HAZIR/ARMED + en iyi 5 PRE-BREAKOUT DISCOVERY her dakika hızlı takip edilir.
- Geri kalan yeterli likiditeli evren 12 coinlik rotating shard ile taranır. Tam tur süresi gerçek universe sayısına göre panelde dinamik gösterilir.

PRE-BREAKOUT DISCOVERY (TRADE DEĞİLDİR)
Amaç Belit EDU/UNI benzeri yapıları patlamadan önce bulmak:
- 2+ testli yatay direnç/destek
- sınırın yaklaşık %8 içinde olma
- higher-low (LONG) / lower-high (SHORT) merdiveni
- günlük compression / directional squeeze
- SMA rejiminin toparlanması
- base/boundary olgunluğu
- 4s+1s ikisi birden net ters yöndeyse discovery reddedilir
- Hacim discovery için zorunlu DEĞİL; yalnız küçük bonus. Hacim/momentum ağırlığı HAZIR/ARMED ve PAPER GİR aşamasında artar.
- En iyi 5 discovery web panelinde görünür ve hızlı takibe alınır. Telegram'a discovery mesajı gönderilmez.

İŞLEM ZİNCİRİ
DISCOVERY -> HAZIRLANIYOR/ARMED -> gerçek 15dk/yatay/flag tetik -> Emre+Aksel+Belit konsensüsü -> PAPER GİR

PAPER GİR aynı sıkılıkta kalır:
- Hybrid Execution >= 7.5
- Emre >= 6.0
- Aksel >= 6.5
- Belit >= 6.25
- gerçek breakout/retest tetik
- Last/Mark giriş geçerliliği
- funding filtresi
- riskOk + rangeOk
- uzamış/kaçmış hareket yok

Margin: 7.5–7.9 = 5–7 USDT; 8.0–8.5 = 10; 9+ = 15; 5x.
Telegram yalnız PAPER GİR LONG/SHORT sinyallerini gönderir.
V3.1 işlemleri önceki V2.x/V3.0 kayıtlarından ayrı yeni örneklem olarak sayılır.
