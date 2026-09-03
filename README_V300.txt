V3.0.2 HARDENED HOTFIX

V3.0.1 HOTFIX: Coin bazlı hata izolasyonu eklendi;  Yönü henüz oluşmamış coinlerde hybridReasons oluşturulurken undefined.slice hatası engellendi. Tek bir eksik veri satırı artık taramanın tamamını düşürmez. V3.0 paper örneklemi korunur.

BingX Paper Bot V3.0 — Emre + Aksel + Belit Consensus

PAPER/TEST ONLY. worker env EXECUTION_MODE zorla TEST'e çevrilir.

Karar mimarisi:
1) Emre katmanı (rejim/harita): 4s+1s HTF trend, 1G SMA rejimi, 4s RSI, objektif impuls + Fibonacci retracement, HTF/Fib invalidation.
2) Aksel/TechCharts katmanı (yapı): yatay boundary/test kalitesi veya 4s flag/channel; kapanışla breakout/retest; pattern invalidation; giriş güncelliği.
3) Belit katmanı (execution): SMA10/20/50/100/200, sıkışma, hacim/order-flow, ADR/ATR, 15dk hızlı tetik, uzama/KAÇTI filtresi.

PAPER GİR için:
- Hybrid Execution >= 7.5
- Emre >= 6.0
- Aksel >= 6.5
- Belit >= 6.25
- gerçek tetik (yatay breakout/retest veya flag/channel breakout/retest)
- Last/Mark giriş geçerliliği
- funding filtresi
- riskOk + rangeOk
- uzamış hareket yok

Not: Elliott Wave sayımı doğası gereği öznel olduğundan otomatik V3.0 motorunda doğrudan dalga numarası üretmez. Emre yaklaşımının otomasyona uygun objektif parçaları (HTF, Fib, RSI/momentum, invalidation) kullanılır.

Tarama:
- İlk 10 likit + CORE5 her dakika
- En iyi 5 HAZIR/ARMED her dakika hızlı takip
- Top100 yaklaşık 10 dakikada tam tur
- Telegram yalnız PAPER GİR
- Margin: 7.5–7.9 = 5–7 USDT; 8.0–8.5 = 10; 9+ = 15; 5x
