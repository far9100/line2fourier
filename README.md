# line2fourier

**Draw a line with a chain of turning circles: its Fourier series, one circle per term.**<br>
**用一串轉動的圓畫出線稿：傅立葉級數的每一項就是一個圓。**

[English](#english) · [繁體中文](#繁體中文)

---

## English

line2fourier takes a closed line, a random doodle or one you draw, and writes the whole picture as a
single Fourier series. Every term is a circle turning at its own constant speed; chained end to end,
the pen on the last circle draws the line again. Move a slider to use more or fewer circles and watch
how close the drawing gets. Everything runs in your browser: nothing is uploaded.

```
R=[0.70052,0.10247,0.09830]
K=[1,-1,2]
P=[0.38877,-1.23757,-2.15266]
(-0.06466+\operatorname{total}(R\cos(2\pi Kt+P)),-0.08679+\operatorname{total}(R\sin(2\pi Kt+P)))
```

*The first three circles of a random creature (seed 42), ready to paste into Desmos.*

### Use it online

The repository carries a GitHub Pages workflow (`.github/workflows/pages.yml`). With Pages set to
"GitHub Actions", every push to `main` publishes the page, and it runs entirely in the visitor's
browser.

### Install

You need Node.js 22.12 or newer.

```
npm ci
npm run dev        # the page at http://localhost:5173
npm run build      # a static site in dist/, for any web server
npm test           # unit tests (Vitest)
npm run test:e2e   # end-to-end tests in the Edge or Chrome you have installed (Playwright)
npm run bench      # how long the maths takes (spec §6)
```

### Use it in the browser

- **New drawing** makes a random creature, scribble or spiky star; the menu next to it picks the
  kind. The seed is shown under **More settings**, where you can also type one to get a drawing
  back.
- **Draw your own**: press and drag on the canvas, with a mouse, a finger or a pen, and let go. The
  line is closed with a straight segment, shown dashed.
- **Show convergence** runs through 1, 2, 3, 5, 10, 20, 50, 100, 300 and 1000 circles, one cycle
  each.
- **Number of circles** moves along the scale 1, 2, 3, 4, 5, 6, 8, 10, … 1000 up to N − 1; the box
  next to it takes any whole number.
- **By size** uses the largest circles first: for any number of circles that is the closest fit
  there is. **By frequency** uses the slowest first, like a low-pass filter.
- Keys: Space plays and pauses; ← and → change the number of circles (with Shift, one at a time);
  D starts drawing; Esc cancels drawing or the demo.

### What the numbers say

| Number | Meaning |
|---|---|
| Energy captured | Σ\|c_k\|² of the circles in use over Σ\|c_k\|² of all of them (Parseval) |
| RMS error | The root mean square distance from the samples to the curve, as a share of the drawing's size |
| Mean deviation | The mean distance from the samples to the curve, as a share of the drawing's size |
| Largest circle | Its radius, the way it turns and how many turns it makes per cycle |

The size of a drawing is the long side of its bounding box. The energy ratio reaches 99.9% with very
few circles, so the page shows it to the first digit short of 100%; the RMS error says more.

### Paste into Desmos

**Copy for Desmos** copies four lines: the radii R, the turns per cycle K, the starting angles P and
one parametric curve. Paste them into an empty expression in [Desmos](https://www.desmos.com/calculator)
and they become four expressions; t runs from 0 to 1 by default.

**Copy for Desmos, with an M slider** adds a line `M=…` and sums over `R[1...M]`, `K[1...M]` and
`P[1...M]`, with at least 300 circles in the lists. Desmos starts a new slider at −10: click the
numbers at its ends and set it to run from 1 in steps of 1.

Both were pasted into Desmos and checked against the page; the screenshots are in
[docs/acceptance](docs/acceptance/). Desmos draws the pen-up jumps between strokes, which the page
leaves out.

### Saving

| Output | Contents |
|---|---|
| Coefficients (JSON) | Every c_k (k, re, im), N, M, the order, the source and the k of the circles in use |
| SVG | The curve for the current number of circles as one path, sized in millimetres for pen plotters and laser cutters |
| Project | The drawing (generator and seed, or your points), N, M, the order, the speed and the view |

Opening a project computes everything again and gives exactly the same result.

### The mathematics

- Read a closed curve as a complex function z(t) = x(t) + i·y(t), t ∈ [0, 1); it can be written
  z(t) = Σ c_k·e^{2πikt}. Each term is a circle of radius |c_k| that turns k times per cycle,
  starting at the angle arg(c_k).
- **Finitely many circles are always an approximation.** As the number of circles goes to infinity,
  the partial sums converge uniformly to the curve as long as it is continuous and of finite length
  (the Dirichlet–Jordan theorem).
- How fast depends on how smooth the curve is: on a curve that is smooth everywhere the coefficients
  fall off quickly; with sharp corners |c_k| falls off about like 1/k², so with too few circles the
  corners are rounded and straight edges ripple.
- The page takes N points at equal arc length along the line (N = 1024 unless you change it) and
  uses their discrete Fourier transform. With all N − 1 circles the curve passes through every one
  of those points.

### More

- [DECISIONS.md](DECISIONS.md): every choice the specification left open, and why.
- [line2fourier-spec.md](line2fourier-spec.md): the specification (Traditional Chinese).
- [line2func](https://github.com/far9100/Line-to-function) turns the lines of an image into cubic
  curves and Desmos equations; line2fourier writes a whole drawing as one series.

### License

[GNU General Public License v3.0 or later](LICENSE). Third-party code: [THIRD_PARTY.md](THIRD_PARTY.md).

---

## 繁體中文

line2fourier 把一條封閉的線（隨機產生的線稿，或你自己畫的）寫成單獨一條傅立葉級數。每一項是一個以固定速度轉動的圓，把圓頭尾相接，最後一個圓上的筆尖就把線重新畫出來。拖動滑桿增減圓的數量，就能看到圖形逼近到什麼程度。所有運算都在瀏覽器裡完成，不會上傳任何資料。

```
R=[0.70052,0.10247,0.09830]
K=[1,-1,2]
P=[0.38877,-1.23757,-2.15266]
(-0.06466+\operatorname{total}(R\cos(2\pi Kt+P)),-0.08679+\operatorname{total}(R\sin(2\pi Kt+P)))
```

*隨機小怪獸（種子 42）的前三個圓，可以直接貼進 Desmos。*

### 線上使用（免安裝）

專案附有 GitHub Pages 的 workflow（`.github/workflows/pages.yml`）。在 Pages 設定把來源選為「GitHub Actions」，之後每次推送到 `main` 就會自動發布，網頁完全在使用者的瀏覽器裡執行。

### 安裝

需要 Node.js 22.12 以上。

```
npm ci
npm run dev        # 網頁在 http://localhost:5173
npm run build      # 在 dist/ 產生靜態網站，可放在任何網頁伺服器
npm test           # 單元測試（Vitest）
npm run test:e2e   # 用電腦上已安裝的 Edge 或 Chrome 跑端對端測試（Playwright）
npm run bench      # 量測數學運算的耗時（規格 §6）
```

### 用瀏覽器

- 〔換一張線稿〕隨機產生小怪獸、塗鴉或尖角星形，旁邊的選單可以指定類型。〔更多設定〕裡會顯示種子，也可以輸入種子，畫出同一張線稿。
- 〔自己畫〕：用滑鼠、手指或觸控筆在畫布上按住拖曳，放開就完成。線會用一段直線自動閉合，以虛線標示。
- 〔示範收斂〕依序用 1、2、3、5、10、20、50、100、300、1000 個圓，各畫一輪。
- 〔圓的數量〕沿著 1、2、3、4、5、6、8、10……1000 一直到 N − 1 的刻度移動；旁邊的輸入框可以填任何整數。
- 〔依大小〕先用最大的圓：在同樣的圓數下，這是誤差最小的選法。〔依頻率〕先用轉得最慢的圓，相當於低通濾波。
- 鍵盤：空白鍵播放／暫停；←／→ 增減圓的數量（加 Shift 每次一個）；D 開始自己畫；Esc 取消手繪或示範。

### 數字的意思

| 數字 | 意義 |
|---|---|
| 能量比例 | 使用中的圓的 Σ\|c_k\|² ÷ 全部圓的 Σ\|c_k\|²（帕塞瓦爾定理） |
| RMS 誤差 | 取樣點到逼近曲線距離的均方根，以線稿大小的百分比表示 |
| 平均偏差 | 取樣點到逼近曲線距離的平均，以線稿大小的百分比表示 |
| 最大的圓 | 半徑、轉向，以及每輪轉幾圈 |

線稿大小是外框的長邊。能量比例只要很少的圓就超過 99.9%，所以會顯示到第一個不是 9 的位數；RMS 誤差更能看出差別。

### 貼進 Desmos

〔複製 Desmos 算式〕會複製四行：半徑 R、每輪圈數 K、起始角 P，以及一條參數式。貼進 [Desmos](https://www.desmos.com/calculator) 空白的算式欄，就會變成四個算式；t 預設從 0 到 1。

〔複製 Desmos 算式（含 M 滑桿）〕多一行 `M=…`，並改成對 `R[1...M]`、`K[1...M]`、`P[1...M]` 求和，清單至少有 300 個圓。Desmos 新建的滑桿從 −10 開始：點滑桿兩端的數字，把範圍改成從 1 開始、間隔 1。

兩種版本都實際貼進 Desmos，並與網頁畫面比對過，截圖放在 [docs/acceptance](docs/acceptance/)。Desmos 會畫出筆畫之間的跳線，網頁則不畫。

### 存檔

| 輸出 | 內容 |
|---|---|
| 係數（JSON） | 全部的 c_k（k、re、im）、N、M、排序方式、來源，以及使用中的圓的 k |
| SVG | 目前圓數的逼近曲線，單一路徑，以公釐為單位，可給筆繪機或雷射切割使用 |
| 專案 | 線稿（產生器與種子，或你畫的點）、N、M、排序、速度與檢視設定 |

開啟專案時會重新計算，得到完全相同的結果。

### 數學

- 把閉合曲線看成複數函數 z(t) = x(t) + i·y(t)，t ∈ [0, 1)，可寫成 z(t) = Σ c_k·e^{2πikt}。每一項是一個半徑 |c_k|、每輪轉 k 圈、起始角為 arg(c_k) 的圓。
- **有限個圓永遠是近似。** 圓的數量趨近無限時，只要曲線連續且長度有限，部分和會均勻收斂到原曲線（Dirichlet–Jordan 定理）。
- 收斂速度取決於曲線的光滑度：處處光滑的曲線，係數衰減得很快；有尖角的曲線 |c_k| 約以 1/k² 衰減，圓不夠時尖角會被磨圓、直邊出現小波紋。
- 網頁沿著線以等弧長取 N 個點（預設 N = 1024），再做離散傅立葉轉換。用上全部 N − 1 個圓時，曲線會通過每一個取樣點。

### 更多說明

- [DECISIONS.md](DECISIONS.md)：規格書沒有定義的細節，以及這樣決定的理由。
- [line2fourier-spec.md](line2fourier-spec.md)：規格書。
- [line2func](https://github.com/far9100/Line-to-function) 把圖片裡的線條描成三次曲線與 Desmos 算式；line2fourier 則把整張圖寫成一條級數。

### 授權

[GNU General Public License v3.0 或更新版本](LICENSE)。第三方程式：[THIRD_PARTY.md](THIRD_PARTY.md)。
