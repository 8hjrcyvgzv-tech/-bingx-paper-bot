# V4 REPLAY LAB

## Amaç

V4 Clean Core'un gerçekten V3.2'den daha iyi olup olmadığını geçmiş veride,
geleceği görmeden ve kuralları sonradan uydurmadan test etmek.

V4 ancak ölçülebilir biçimde üstünse PAPER aşamasına geçer.

---

## Ana karşılaştırma

Her test döneminde aynı piyasa verisi üzerinde:

- V3.2
- V4 Clean Core

yan yana çalıştırılır.

Aynı sembol, aynı zaman aralığı ve aynı veri kullanılır.

---

## V4 oyun planı

RADAR -> DIRECTION -> STRUCTURE -> FLOW -> EXECUTION

### DIRECTION — Emre
- HTF trend
- market structure
- Elliott/Fib bağlamı
- ana senaryo
- invalidation

### STRUCTURE — Aksel
- destek / direnç
- sıkışma
- klasik formasyon
- boundary testleri
- breakout / retest

### EARLY MOVE / RADAR — Belit
- base / consolidation
- hacim ivmesi
- compression
- SMA uyumu
- ATR / ADR
- erken momentum

### FLOW — Doruk
- spot / futures CVD
- Open Interest
- Funding
- liquidation context
- absorption
- leverage-driven move kontrolü

### EXECUTION — Mr. Trader
- giriş bölgesi
- invalidation
- stop
- TP1 / TP2
- kademe
- risk yönetimi
- geç kalmış giriş kontrolü

### PERFORMANCE — Tiberius
- backtest disiplini
- out-of-sample kontrolü
- overfit kontrolü
- drawdown analizi
- expectancy
- false-positive / false-negative analizi

---

## Hard veto

Sadece gerçek risk durumları işlemi tamamen öldürebilir:

1. HTF senaryo açık şekilde invalid
2. Risk / reward yetersiz
3. Giriş aşırı uzamış / geç kalmış
4. Likidite veya piyasa yapısı riski kabul edilemez

Diğer göstergeler mümkün olduğunca veto değil SKOR üretir.

---

## Replay kuralları

1. Her mum yalnız kapanmış geçmiş veriyi görebilir.
2. Gelecek mumlardan hiçbir bilgi kullanılamaz.
3. Setup oluştuktan sonra kurallar değiştirilemez.
4. Komisyon ve makul slippage hesaba katılır.
5. Kazanan örneklere özel sonradan kural eklenmez.
6. Kaybeden işlemler de eksiksiz kaydedilir.
7. PAPER veya gerçek performans gibi sunulmaz; REPLAY/BACKTEST olarak etiketlenir.

---

## İlk test dönemi

Başlangıç:

- Son 30 gün

İkinci aşama:

- Son 60 gün

Sonraki hedef:

- En az 100 anlamlı setup

CORE5:

- BTC-USDT
- ETH-USDT
- SOL-USDT
- XRP-USDT
- DOGE-USDT

Geniş evren testi ayrıca yapılır.

---

## Özel regresyon örnekleri

### XRP
Amaç:
Yaklaşık %5-%6'lık son hareketin ilk safhasını sistem görebiliyor muydu?

Ölç:

- ilk radar zamanı
- ilk aday zamanı
- giriş anındaki hareket yüzdesi
- kaç R potansiyel kalmıştı
- hangi filtre reddetti
- sonradan maksimum hareket

### ZEC
Amaç:
Catalyst + hacim + breakout + leverage momentum hareketinin erken safhasını yakalamak.

Ölç:

- ilk hacim anomalisi
- ilk breakout hazırlığı
- ilk valid risk/reward
- işlem olsaydı sonuç
- V3.2 neden gördü/görmedi
- V4 neden gördü/görmedi

---

## Her aday için kayıt

- timestamp
- symbol
- direction
- market regime
- radar score
- direction score
- structure score
- flow score
- execution score
- final score
- veto varsa nedeni
- entry
- stop
- TP1
- TP2
- risk/reward
- outcome R
- MFE
- MAE
- 15m sonrası
- 1h sonrası
- 4h sonrası
- missed move classification

---

## Missed move sınıfları

- RADAR_MISS
- DIRECTION_FAIL
- STRUCTURE_FAIL
- FLOW_FAIL
- EXECUTION_FAIL
- RR_FAIL
- TOO_LATE
- CORRECT_REJECTION

Amaç sadece "kaçırdık" demek değil,
hangi modülün kazanan hareketi öldürdüğünü bulmak.

---

## Ana performans metrikleri

- toplam setup
- toplam trade
- win rate
- average R
- expectancy
- profit factor
- maximum drawdown
- median MFE
- median MAE
- false-positive rate
- false-negative rate
- radar -> candidate conversion
- candidate -> trade conversion
- early capture rate

---

## Early Capture Rate

Önemli hareketlerde sistemin giriş yaptığı anda
toplam hareketin ne kadarı henüz önündeydi?

Örnek:

Coin toplam +6% yaptı.
Sistem +1.2%'de aday ürettiyse erken yakalama başarılıdır.
Sistem +5%'te sinyal verdiyse teknik olarak doğru olsa bile geçtir.

---

## V4 başarı kriteri

V4 yalnız daha fazla trade ürettiği için başarılı sayılmaz.

Başarılı sayılması için V3.2'ye göre genel olarak:

- daha yüksek expectancy
- daha iyi veya benzer profit factor
- kabul edilebilir drawdown
- daha düşük anlamlı false-negative
- daha yüksek early capture rate
- yeterli örnek sayısı

üretmelidir.

---

## Yasak

- Gerçek emir açmak
- Backtest sonucunu gerçek kazanç gibi sunmak
- Tek XRP veya ZEC örneğine göre sistemi optimize etmek
- Her kayıptan sonra yeni filtre eklemek
- Her kaçan hareket sonrası eşik düşürmek
- Look-ahead bias
- Hindsight rule creation

---

## Durum

V4_REPLAY_LAB_STATUS = DESIGN_LOCKED
LIVE_TRADING = DISABLED
PAPER_TRADING = NOT_APPROVED_YET
