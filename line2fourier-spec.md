# line2fourier：本輪繪圖機 開發規格書

> 給 coding agent 的實作說明。專案名稱為暫定，可更換。
> 文件用繁體中文；程式碼、識別字與 commit 訊息用英文。
> 需求有衝突時，以 §4 數學模型、§11 參考實作與 §12 驗收標準為準。

## 0. 摘要（TL;DR）

- 做一個**純前端**網頁工具：輸入一張線稿（隨機產生、手繪、SVG、line2func 的輸出或圖片），把它變成一條封閉路徑，用傅立葉級數拆成一串「頭尾相接、各自等速轉動的圓」（本輪），再用動畫重畫出來。
- 使用者可調整圓的數量、速度與排序方式，即時看到逼近程度（能量比例、誤差），並匯出 Desmos 算式、LaTeX、係數 JSON 與 SVG；後續加入影片、示波器音訊、翻頁書等實體輸出。
- 核心演算法已用單檔原型驗證；§11 的參考實作通過 §12 列出的全部數學測試。
- 所有運算在瀏覽器完成，不上傳任何資料（與 line2func 相同）。

## 1. 背景與數學主張

- 參考專案：[line2func](https://github.com/far9100/Line-to-function)。它把線稿描成一段段三次曲線，再輸出成 Desmos 算式。本專案改用傅立葉級數，以**單獨一條式子**描述整張圖，兩者可以互通（§5.4）。
- 名稱由來：「本輪」（epicycle）原是托勒密天文學中「圓上再套圓」的行星模型；這裡的每個圓都是傅立葉級數中的一項。
- 精確敘述（UI 說明與 README 都要用這個版本，不要寫「任何圖案都能完美重現」）：
  - 把閉合曲線看成複數函數 `z(t) = x(t) + i·y(t)`，`t ∈ [0, 1)`，可寫成 `z(t) = Σ_k c_k · e^{2πikt}`。每一項是一個半徑 `|c_k|`、每輪轉 `k` 圈、起始角為 `arg(c_k)` 的圓。
  - **有限個圓永遠是近似。** 圓的數量趨近無限時，只要曲線連續且長度有限，部分和會均勻收斂到原曲線（Dirichlet–Jordan 定理）。
  - 收斂速度取決於曲線的光滑度：處處光滑的曲線，係數衰減得很快；有尖角的曲線 `|c_k|` 約以 `1/k²` 衰減，圓不夠時尖角會被磨圓、直邊出現小波紋。

## 2. 名詞

| 名詞 | 定義 |
|---|---|
| 路徑 | 封閉折線，依序串起所有筆畫，必要時含「跳線」。 |
| 取樣點 `z_n` | 沿路徑等弧長取的 `N` 個點，視為複數 `x + iy`。 |
| 係數 `c_k` | 離散傅立葉係數，`k ∈ [-N/2, N/2)`。 |
| 本輪（圓） | 一個 `c_k`（`k ≠ 0`）：半徑 `|c_k|`，每輪轉 `k` 圈（正為逆時針、負為順時針），起始角 `arg(c_k)`。 |
| `c_0` | 不轉動的常數項，等於取樣點的平均（重心）。 |
| `M` | 使用的圓數（不含 `c_0`）。 |
| 跳線（pen-up） | 多筆畫之間的連接段，參與計算但不畫出。 |
| 能量比例 | 已使用的圓的半徑平方和 ÷ 全部圓的半徑平方和（帕塞瓦爾定理）。 |

## 3. 座標系、單位與預設值

- 內部運算使用數學座標（y 向上）；畫布的 y 向下，繪製時翻轉。SVG 與手繪輸入（y 向下）匯入時也要翻轉。
- 隨機與匯入的線稿先平移、縮放到 `[-1, 1]²`（以外框中心為原點、長邊半長為 1）；手繪線稿保留使用者畫的位置與大小。

| 參數 | 預設 | 說明 |
|---|---|---|
| 取樣數 `N` | 1024 | 2 的冪次，可選 512–8192 |
| 圓數 `M` | 50 | 滑桿採非線性刻度：1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000…，上限 `N − 1` |
| 排序 | 依大小 | 另一選項：依頻率 `|k|` |
| 一輪時間 | 8 秒（1× 速度） | 速度 0.25×–3× |
| 示範收斂 | M 依序為 1, 2, 3, 5, 10, 20, 50, 100, 300, 1000 | 每輪 3.5 秒，畫完一輪換下一個 |
| 圓的繪製門檻 | 半徑 ≥ 0.8 px | 更小的圓不畫，但仍參與計算 |
| 隨機種子 | 每次「換一張線稿」產生新種子 | 顯示在 UI 並存進專案檔，可重現 |

## 4. 數學模型

### 4.1 等弧長取樣

把封閉折線（自動補上終點到起點的線段）依弧長平分成 `N` 份取點。參數化方式會影響係數；等弧長能讓筆尖等速移動，細節分配也比較均勻。實作見 §11 `resampleClosed`。

### 4.2 傅立葉係數

```
c_k = (1/N) · Σ_{n=0}^{N-1} z_n · e^{-2πikn/N},   k = -N/2 … N/2-1
```

以 radix-2 FFT 計算（O(N log N)）。FFT 第 `m` 個輸出對應 `k = m`（當 `m < N/2`）或 `k = m − N`。

### 4.3 本輪鏈與部分和

```
z_M(t) = c_0 + Σ_{j=1}^{M} c_{k_j} · e^{2πi k_j t}
```

- 第 j 個圓的圓心是前 j − 1 項的和，筆尖是全部 M 項的和（§11 `chainAt`，每格動畫 O(M)）。
- 完整的逼近曲線，用「只保留前 M 項的係數」做一次反 FFT 求得（§11 `partialCurve`，O(N log N)）。

### 4.4 排序

- `magnitude`（預設）：依 `|c_k|` 由大到小。由帕塞瓦爾定理可知，這是相同 M 下 L² 誤差最小的選法。
- `frequency`：依 `|k|` 由小到大（同 `|k|` 時正頻率在前），相當於低通濾波，畫面上是由慢到快。

### 4.5 指標

```
能量比例  E_M    = Σ_{used} |c_k|² / Σ_{k≠0} |c_k|²
RMS 誤差  e_rms  = sqrt( Σ_{dropped} |c_k|² )      // 等於取樣點與逼近曲線距離的均方根
平均偏差  e_mean = (1/N) · Σ_n |z_n − z_M(n)|
```

誤差顯示時除以線稿外框寬度，以百分比呈現；另外顯示最大圓的半徑（相對寬度）、轉向與每輪圈數。

### 4.6 多筆畫與跳線

- 多筆畫（SVG、line2func、點陣圖）要串成一條封閉路徑：以最近鄰法決定筆畫順序與方向（每筆可正走或反走），可選 2-opt 改善，使跳線總長最小；最後一筆接回第一筆的起點。
- 每個取樣點記錄是否落在跳線上（`penUp[n]`）。跳線照常參與傅立葉計算，但原始線稿與逼近軌跡在跳線處斷開不畫。
- 跳線越長，需要的圓越多；UI 要顯示跳線總長占路徑總長的比例。

### 4.7 不變性（可當測試）

- 起點循環平移不改變 `|c_k|`。
- 反轉方向使 `c_k ↔ c_{-k}`。
- 平移只改變 `c_0`；縮放 s 倍使所有 `c_k` 乘以 s。

## 5. 輸入來源

### 5.1 隨機線稿（MVP）

三種產生器都使用可設定種子的亂數（§11 `mulberry32`），輸出後依 §3 正規化：

- **小怪獸**：極座標輪廓 `r(θ) = 0.55·(1 + 0.08·sin(2θ + a₁) + 0.05·sin(3θ + a₂)) + Σ 凸起`，取 720 點，x 方向再拉長 1–1.35 倍。凸起包括：頂部兩個三角形耳朵（距正上方 ±0.35–0.6 rad）、底部 2 或 4 條平頂的腳、單側一條細長尾巴、背上 0–3 根小刺。三角形凸起為 `tri(u) = max(0, 1 − |u|)`；平頂凸起在 `|u| < 0.6` 時為 1，之後以餘弦降到 0。
- **塗鴉**：6–10 個控制點，依角度大致繞一圈（角度擾動 ±0.4 rad、半徑 0.35–1），在其中 1–3 個點加入小迴圈（沿前進方向繞一圈半徑 0.1–0.2 的圓），再用封閉 Catmull–Rom 曲線（每段 30 點）連起來。
- **尖角星形**：5–9 個尖角，外半徑 0.75–1、內半徑約 0.3–0.6，各點再隨機擾動，以折線連接；用來展示尖角收斂慢的現象。

### 5.2 手繪（MVP）

- 點「自己畫」後，畫布設為 `touch-action: none`，用 Pointer Events 收集點（與上一點距離 > 2 px 才收）；放開時自動用直線閉合，閉合段在畫面上以虛線標示。
- 少於 8 點或總長小於 60 px 時不處理，並提示「線太短了，再畫長一點」。
- 支援滑鼠、觸控與觸控筆；畫完自動回到播放模式。

### 5.3 SVG（M2）

- 用瀏覽器內建的 `getTotalLength()` 與 `getPointAtLength()` 取樣；line、polyline、polygon、rect、circle、ellipse 先轉成 path 再處理。
- 一條 path 含多個子路徑時，拆成多個暫時的 path 元素分別取樣（注意相對座標 `m` 的起點），每個子路徑視為一筆畫。
- 套用元素的 transform（`getCTM()`），再依 §4.6 串接所有筆畫。

### 5.4 line2func 的 `curves.json`（M2）

- 依 line2func 文件（`docs/details.md`）中的實際欄位撰寫轉接器：每條三次曲線以控制點取樣，同一筆畫的曲線依序相接，再依 §4.6 串接所有筆畫。
- 這讓兩個專案互補：line2func 負責從圖片描出曲線，本專案把整張圖寫成一條傅立葉級數。

### 5.5 點陣圖（M3）

- 流程：轉灰階 → Otsu 二值化 → Zhang–Suen 細線化 → 從端點與分岔點追蹤骨架成折線 → Douglas–Peucker 簡化 → 依 §4.6 串接。
- 照片不在範圍內；UI 建議先用 line2func 處理照片，再匯入 `curves.json`。

## 6. 介面需求

- 控制列：換一張線稿（附類型選單）、自己畫、上傳線稿、示範收斂、播放／暫停。
- 滑桿：圓的數量（非線性刻度，即時顯示 M）、速度。
- 切換：排序方式（依大小／依頻率）、顯示圓、顯示原始線稿、跟隨筆尖（以筆尖為中心放大 1–50 倍，看得到極小的圓）。
- 主畫布：
  - 原始線稿：虛線、低對比。
  - 逼近曲線：第一輪畫完後，以淡色顯示完整曲線。
  - 本輪軌跡：每輪從頭以實線畫出，畫到筆尖為止。
  - 圓與連桿：圓用細線、低不透明度，連桿稍深；`c_0` 以一根固定不動的連桿表示。
  - 筆尖：實心圓點。
- 頻譜面板（M2）：以對數刻度畫出 `|c_k|`（k 從 −K 到 K），標出目前使用的項；點選任一項會在畫布上標亮對應的圓，並顯示 k、`|c_k|`、`arg(c_k)`。
- 指標卡：能量比例、RMS 誤差、平均偏差、最大圓（半徑、轉向、每輪圈數）。
- 公式面板：以 KaTeX 顯示級數的前幾項，並提供「複製 Desmos 算式」「複製 LaTeX」按鈕。
- 鍵盤：空白鍵播放／暫停，左右方向鍵增減 M，`D` 進入手繪。
- 效能：`N = 1024` 時重新計算（FFT 加部分和）< 10 ms；`M ≤ 300` 時動畫在中階筆電達 60 fps，手機 ≥ 30 fps；`N ≥ 4096` 的 FFT 與影像處理放在 Web Worker。
- `prefers-reduced-motion` 時預設暫停，直接顯示完整逼近曲線。
- 語言：預設繁體中文，可切換英文。
- 隱私：除了載入網站本身的靜態資源，不發出任何網路請求。

## 7. 視覺與文案方向

- 主題取自「本輪」的來源：古典星圖與黃銅天象儀。畫面主角是轉動的圓與筆尖，其他介面保持安靜；全站只保留一個主動畫（開啟時自動播放一張隨機線稿）。
- 色彩提案（淺色／深色，可調整）：紙面 `#EEF2F6`／`#121821`、星圖墨色 `#1E2B44`／`#DCE3EE`、軌道線 `#93A1B8`／`#5E6B80`、黃銅（筆尖與軌跡）`#B7791F`／`#E0A84A`、選取 `#2A9D8F`／`#4CC3B4`、警示 `#C8423B`／`#E86B63`。
- 字體：Noto Sans TC 或系統字；數字使用 `font-variant-numeric: tabular-nums`；數學式用 KaTeX。
- 文案用動詞、講結果：「換一張線稿」「自己畫」「複製 Desmos 算式」。避免「完美重現」這類過度承諾，改說「圓越多越接近」。

## 8. 匯出

| 格式 | 內容 | 里程碑 |
|---|---|---|
| Desmos | 三個清單 `R`、`K`、`P` 加一條參數式（見下），每行一個算式，可整段貼進 Desmos | M1 |
| LaTeX | 前 M 項的級數 | M1 |
| JSON | 全部係數（k、re、im）、排序方式、N、來源與種子 | M1 |
| SVG | 目前 M 的逼近曲線（單一 path，可設定實際尺寸，給筆繪機或雷射雕刻用） | M1 |
| 影片 | 用 `canvas.captureStream()` 加 `MediaRecorder` 錄一輪動畫（WebM；Safari 用 MP4） | M3 |
| 示波器音訊 | 立體聲 WAV：左聲道 x(t)、右聲道 y(t)，基頻 `f0` 預設 100 Hz、取樣率 48 kHz；示波器切到 XY 模式就會畫出這張圖 | M3 |
| 翻頁書 | 把一輪動畫分成 32 格，排成可列印、裁切、裝訂的 PDF | M3 |

Desmos 格式（由 §11 `toDesmos` 產生，`c0x`、`c0y` 會換成 `c_0` 的實際數值）：

```
R=[0.41230,0.20117,…]
K=[1,-1,2,…]
P=[1.20345,-0.51236,…]
(c0x+\operatorname{total}(R\cos(2\pi Kt+P)),c0y+\operatorname{total}(R\sin(2\pi Kt+P)))
```

- Desmos 參數式的 t 預設範圍就是 0 到 1。
- 選做：可調圓數的版本，加一個滑桿 `M`，並把三個清單改成 `R[1...M]`、`K[1...M]`、`P[1...M]`。
- 兩個版本都要實際貼進 Desmos 驗證（列在 M1 驗收）。

示波器音訊的限制：每一項的頻率 `|k|·f0` 必須低於奈奎斯特頻率 `fs/2`，超過的項要捨棄並提示（`f0 = 100 Hz`、`fs = 48 kHz` 時最多到 `|k| = 239`）；輸出前把振幅正規化到峰值 0.9。App 內提供即時播放與 XY 預覽（用 Web Audio 的 `AnalyserNode` 讀左右聲道來畫）。

## 9. 技術架構

- TypeScript + Vite，純靜態網站，可部署到 GitHub Pages。
- 繪圖用 Canvas 2D；FFT 用 §11 的實作；KaTeX 顯示公式；pdf-lib 產生翻頁書；WAV 自行寫入（16-bit PCM）。
- Web Worker：大 N 的 FFT、SVG 與點陣圖處理、筆畫排序。
- 測試：Vitest（單元測試）；Playwright（端對端，選做）。
- 不使用後端。

建議目錄：

```
line2fourier/
├─ index.html
├─ src/
│  ├─ core/
│  │  ├─ fourier.ts          // §11 參考實作
│  │  ├─ generators.ts       // 小怪獸、塗鴉、尖角星形
│  │  ├─ tour.ts             // 多筆畫串接、跳線遮罩
│  │  ├─ svgImport.ts
│  │  ├─ line2funcImport.ts
│  │  └─ raster.ts           // Otsu、Zhang–Suen、骨架追蹤（M3）
│  ├─ render/
│  │  ├─ canvasView.ts       // 主畫布、跟隨筆尖
│  │  └─ spectrumView.ts
│  ├─ export/
│  │  ├─ desmos.ts
│  │  ├─ latex.ts
│  │  ├─ json.ts
│  │  ├─ svg.ts
│  │  ├─ video.ts            // M3
│  │  ├─ audio.ts            // M3
│  │  └─ flipbook.ts         // M3
│  ├─ ui/
│  └─ i18n/
│     ├─ zh-TW.json
│     └─ en.json
└─ tests/
```

## 10. 專案檔格式

```json
{
  "version": 1,
  "source": { "type": "random", "generator": "creature", "seed": 123456789 },
  "N": 1024,
  "M": 50,
  "order": "magnitude",
  "speed": 1,
  "view": { "showCircles": true, "showOriginal": true, "follow": false, "zoom": 1 }
}
```

- `source.type` 可為 `random`、`freehand`（附 `points`）、`svg`、`line2func`、`image`；後三者預設只存檔名與 SHA-256，使用者可選擇內嵌原始內容。
- 係數不存檔，載入時重新計算；相同輸入必須得到完全相同的結果。

## 11. 參考實作（已通過 §12 的 M0 測試）

以下程式碼在 Node 22（`--experimental-strip-types`）下通過 §12 M0 的 11 項測試，可直接作為 `src/core/fourier.ts`：

```ts
export type Pt = [number, number];
export interface Term { k: number; re: number; im: number; amp: number; phase: number; }

/** 沿封閉折線等弧長取 N 點（自動補上終點→起點的線段）。 */
export function resampleClosed(poly: Pt[], N: number): Pt[] {
  const P = poly.concat([poly[0]]);
  const seg: number[] = [];
  let L = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const d = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    seg.push(d);
    L += d;
  }
  if (L === 0) throw new Error('path has zero length');
  const out: Pt[] = [];
  let j = 0, acc = 0;
  for (let n = 0; n < N; n++) {
    const s = (n * L) / N;
    while (j < seg.length - 1 && acc + seg[j] < s) { acc += seg[j]; j++; }
    const u = seg[j] > 0 ? (s - acc) / seg[j] : 0;
    out.push([P[j][0] + u * (P[j + 1][0] - P[j][0]), P[j][1] + u * (P[j + 1][1] - P[j][1])]);
  }
  return out;
}

/** 原地 radix-2 FFT。inverse=false：X_m = Σ z_n e^{-2πimn/N}；inverse=true：Σ X_m e^{+2πimn/N}（不除以 N）。 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + half;
        const br = re[b] * wr - im[b] * wi;
        const bi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - br; im[b] = im[a] - bi;
        re[a] += br; im[a] += bi;
      }
    }
  }
}

/** c_k = (1/N) Σ z_n e^{-2πikn/N}，k ∈ [-N/2, N/2)。 */
export function coefficients(samples: Pt[]): Term[] {
  const N = samples.length;
  const re = new Float64Array(N), im = new Float64Array(N);
  samples.forEach(([x, y], n) => { re[n] = x; im[n] = y; });
  fft(re, im);
  const out: Term[] = [];
  for (let m = 0; m < N; m++) {
    const k = m < N / 2 ? m : m - N;
    const cr = re[m] / N, ci = im[m] / N;
    out.push({ k, re: cr, im: ci, amp: Math.hypot(cr, ci), phase: Math.atan2(ci, cr) });
  }
  return out;
}

/** magnitude：|c_k| 由大到小（L² 最佳）；frequency：|k| 由小到大，同 |k| 時正頻率在前。 */
export function orderTerms(all: Term[], by: 'magnitude' | 'frequency' = 'magnitude'): { c0: Term; terms: Term[] } {
  const c0 = all.find(c => c.k === 0)!;
  const terms = all.filter(c => c.k !== 0);
  if (by === 'magnitude') terms.sort((a, b) => b.amp - a.amp);
  else terms.sort((a, b) => Math.abs(a.k) - Math.abs(b.k) || b.k - a.k);
  return { c0, terms };
}

/** 本輪鏈：回傳各圓心與最後的筆尖，t ∈ [0, 1)，每次 O(M)。 */
export function chainAt(c0: Term, terms: Term[], M: number, t: number): Pt[] {
  let x = c0.re, y = c0.im;
  const joints: Pt[] = [[x, y]];
  for (let j = 0; j < M; j++) {
    const c = terms[j], a = 2 * Math.PI * c.k * t + c.phase;
    x += c.amp * Math.cos(a);
    y += c.amp * Math.sin(a);
    joints.push([x, y]);
  }
  return joints;
}

/** 只保留 c_0 與前 M 項，做反 FFT 得到 N 個時刻的逼近曲線，O(N log N)。 */
export function partialCurve(c0: Term, terms: Term[], M: number, N: number): Pt[] {
  const re = new Float64Array(N), im = new Float64Array(N);
  const put = (c: Term) => { const m = (c.k + N) % N; re[m] = c.re; im[m] = c.im; };
  put(c0);
  for (let j = 0; j < M; j++) put(terms[j]);
  fft(re, im, true);
  return Array.from({ length: N }, (_, n) => [re[n], im[n]] as Pt);
}

/** 能量比例（帕塞瓦爾）、RMS 誤差（= 被捨棄項的平方和開根號）、平均偏差。 */
export function metrics(samples: Pt[], approx: Pt[], terms: Term[], M: number) {
  let total = 0, used = 0;
  terms.forEach((c, j) => { const e = c.amp * c.amp; total += e; if (j < M) used += e; });
  let mean = 0;
  for (let n = 0; n < samples.length; n++) {
    mean += Math.hypot(samples[n][0] - approx[n][0], samples[n][1] - approx[n][1]);
  }
  return {
    energy: total > 0 ? used / total : 1,
    rmsError: Math.sqrt(Math.max(0, total - used)),
    meanDeviation: mean / samples.length,
  };
}

/** 匯出可整段貼進 Desmos 的文字：清單 R、K、P 與一條參數式（t 預設 0 到 1）。 */
export function toDesmos(c0: Term, terms: Term[], M: number, digits = 5): string {
  const f = (v: number) => (Math.abs(v) < 10 ** -digits ? '0' : v.toFixed(digits));
  const use = terms.slice(0, M);
  return [
    `R=[${use.map(c => f(c.amp)).join(',')}]`,
    `K=[${use.map(c => c.k).join(',')}]`,
    `P=[${use.map(c => f(c.phase)).join(',')}]`,
    `(${f(c0.re)}+\\operatorname{total}(R\\cos(2\\pi Kt+P)),${f(c0.im)}+\\operatorname{total}(R\\sin(2\\pi Kt+P)))`,
  ].join('\n');
}

/** 可設定種子的亂數產生器，回傳 [0, 1) 的數。 */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

## 12. 里程碑與驗收標準

### M0 數學核心

用 Vitest 實作下列測試（括號內為容許誤差），§11 的程式碼已全部通過：

1. FFT 與直接計算的 DFT 一致（N = 256 隨機資料，< 1e-9）。
2. 反 FFT 再除以 N 能還原原資料（< 1e-9）。
3. 圓 `z_n = e^{2πin/N}` 只有 `c_1 = 1`，其餘 `|c_k|` < 1e-12。
4. 橢圓 `a·cos + i·b·sin`：`c_1 = (a + b)/2`、`c_{-1} = (a − b)/2`（< 1e-12）。
5. 帕塞瓦爾：`(1/N)·Σ|z_n|² = Σ|c_k|²`（< 1e-12）。
6. 用全部 N − 1 個圓重建取樣點（< 1e-9）。
7. `metrics().rmsError` 等於直接計算的均方根誤差，`chainAt` 的筆尖等於 `partialCurve` 同一時刻的點（皆 < 1e-9）。
8. 相同 M 下，依大小排序的 RMS 誤差不大於依頻率排序。
9. 起點循環平移不改變 `|c_k|`；反轉方向使 `c_k ↔ c_{-k}`（< 1e-12）。
10. 正方形等弧長取樣 400 點，每邊的點數相差不超過 1。
11. Desmos 匯出（M = 20、小數 5 位）解析回來後求值，與 `chainAt` 的結果相差 < 1e-3（以線稿半寬 = 1 為單位）。

### M1 MVP

- 內容：三種隨機線稿（同一種子結果完全相同）、手繪、動畫、圓數與速度滑桿、示範收斂、指標卡、Desmos／LaTeX／JSON／SVG 匯出、中英文介面。
- 驗收：
  - 單元測試全數通過。
  - 把匯出的 Desmos 文字貼進 Desmos，圖形與 App 內相同 M 的逼近曲線一致（人工驗收，附截圖）。
  - 手繪在滑鼠與觸控裝置上都能使用；線太短時顯示提示，程式不出錯。
  - 全程沒有網路請求。

### M2

- 內容：SVG 匯入、line2func `curves.json` 匯入、多筆畫串接與跳線、頻譜面板、排序切換、跟隨筆尖、點選高亮。
- 驗收：
  - 含 3 個以上子路徑的 SVG 能正確串接，跳線不畫出，並顯示跳線總長比例。
  - 排序後的跳線總長，不大於依原始順序串接的總長。
  - 頻譜面板中使用中的項目，與畫布上的圓一一對應。

### M3

- 內容：點陣圖輸入、影片匯出、示波器音訊（含即時播放與 XY 預覽）、翻頁書 PDF。
- 驗收：
  - 音訊中沒有頻率 ≥ fs/2 的項，峰值 ≤ 0.9。
  - 影片長度等於一輪，能正常播放。
  - 翻頁書 PDF 以 100% 列印時裁切線位置正確，格數與順序正確。

## 13. 邊界情況

- 路徑長度為零，或少於 3 個不同的點：拒絕並提示。
- 連續重複的點：取樣時自動略過零長度線段。
- 開放路徑：自動以直線閉合，閉合段以虛線標示。
- 自我交叉的路徑：照常處理即可。
- `M > N − 1`：自動限制為 `N − 1`。
- 筆畫過多（> 2000）或總點數過大：提示並簡化。
- 分頁隱藏時動畫自動暫停（`requestAnimationFrame` 本身會停止）。
- 深色模式：所有顏色都要有深色版本。

## 14. 不在範圍內

- 三維曲線（空間中的本輪）。
- 實體齒輪或連桿機構的設計與製造（可列為未來擴充：前幾個圓的轉速比可換成齒數比）。
- 照片直接轉線稿（交給 line2func）。
- 任何後端服務。

## 15. Agent 工作守則

1. 先完成 `core/`，讓 §12 M0 的測試全部通過，再做介面。
2. §11 的參考實作可直接採用；如需修改，測試仍須全數通過。
3. 遇到本文件沒有定義的細節，選最簡單、可測試的做法，並在 `DECISIONS.md` 記錄理由。
4. 不加入後端、分析追蹤或任何外部 API。
5. README 中英雙語（格式參考 line2func），並使用 §1 的精確數學敘述。

## 16. 參考資料

- line2func：https://github.com/far9100/Line-to-function
- J. W. Cooley, J. W. Tukey. *An Algorithm for the Machine Calculation of Complex Fourier Series.* Mathematics of Computation 19(90), 1965.
- A. Zygmund. *Trigonometric Series.* Cambridge University Press（傅立葉級數收斂定理，含 Dirichlet–Jordan 判別法）。
- T. Y. Zhang, C. Y. Suen. *A Fast Parallel Algorithm for Thinning Digital Patterns.* Communications of the ACM 27(3), 1984.
- N. Otsu. *A Threshold Selection Method from Gray-Level Histograms.* IEEE Transactions on Systems, Man, and Cybernetics 9(1), 1979.
- 3Blue1Brown. *But what is a Fourier series? From heat flow to drawing with circles*（2019，影片；視覺呈現可參考）。
