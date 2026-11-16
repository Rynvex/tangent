# 互動規格

視覺版：`Tangent 互動規格.dc.html`。兩項都沒有做成可操作原型。

## A8・大綱的鍵盤操作

大綱是 `role="tree"`，整棵樹只有一個 tab 停駐點（roving tabindex）。進入時 focus 落在「你在這裡」那一列，沒有的話落在主線。

### 狀態

| 狀態 | 說明 | 視覺 |
|---|---|---|
| `idle` | focus 不在大綱 | 無外框 |
| `focused` | 某一列有 focus | 2px `--tg-ring` 外框 |
| `typeahead` | 連續輸入字元找列 | 500ms 內的字元累加，比對目的開頭 |
| `multiselect` | 多選模式（頂端開關或 ⇧ 點選） | 勾選框＋底部動作列 |
| `renaming` | 改支線目的 | 列內輸入框，≤ 200 字 |

### 對照表

| 在這個狀態 | 輸入 | 結果 | 下一個狀態 |
|---|---|---|---|
| idle | Tab | focus 進大綱，落在「你在這裡」 | focused |
| focused | ↓ / ↑ | 下一個 / 上一個可見列（跳過收合的子列與隱藏的順口問） | focused |
| focused | → | 收合中 → 展開；已展開 → 第一個子列；沒有子列 → 不動 | focused |
| focused | ← | 已展開 → 收合；否則 → 上一層 | focused |
| focused | Home / End | 第一列（主線）/ 最後一個可見列 | focused |
| focused | Enter | 進入這條支線；focus 留在大綱 | focused |
| focused | Space | 多選模式中切換勾選；否則同 Enter | focused / multiselect |
| focused | * | 展開同一層所有兄弟列 | focused |
| focused | F2 | 改目的（只限進行中、有寫入權限） | renaming |
| focused | 字元 | 移到下一個目的開頭符合的列 | typeahead |
| focused | ⇧ ↑ / ⇧ ↓ | 進入多選並延伸範圍 | multiselect |
| multiselect | ⌘ A | 選取所有可見支線（不含主線、順口問） | multiselect |
| multiselect | G | 建立群組（打開 C2 表單） | focused |
| multiselect | Esc | 清除選取 | focused |
| renaming | Enter | 儲存；空白時不存並提示「目的是必填」 | focused |
| renaming | Esc | 放棄 | focused |
| focused | Esc | focus 回到輸入框 | idle |

### 規則

- `aria-level`、`aria-setsize`、`aria-posinset` 依可見樹計算；收合列 `aria-expanded="false"`。
- 「你在這裡」用 `aria-current="location"`，與 focus 分開。
- 未帶回的支線仍可 focus 與進入；已清除的順口問不在樹裡。
- 正在回覆的列以 `aria-describedby` 加「回覆中」，不搶 focus。
- 420 嵌入與手機同一套規則；手機另外支援長按進入多選。
- 宿主可停用大綱快捷鍵，但方向鍵與 Enter 屬於 tree 基本行為，不可停用。

## C3・地圖拉關聯線

關聯連接兩個節點（訊息或支線），附一句說明。手動 = 實線；AI 建議 = 虛線，待確認。地圖不能拖曳節點（自動排版），拖曳只用來拉線與平移。

### 狀態

| 狀態 | 說明 | 視覺 |
|---|---|---|
| `idle` | 沒有拉線 | 節點 hover 時右緣出現 8px 連接點 |
| `armed` | 按住連接點，或鍵盤 R | 來源節點 `--tg-ring` 外框；十字游標 |
| `dragging` | 拖曳中 | 連接點到游標的虛線；可放的節點淡色底 |
| `targeting` | 停在可放的節點上 | 目標外框；線吸附到目標左緣 |
| `labeling` | 放開後寫說明 | 線中間輸入框，≤ 120 字，可留白 |
| `committed` | 已建立 | 實線＋說明標籤 |
| `suggested` | AI 建議 | `--tg-suggestion` 虛線＋「確認 / 移除」 |

### 對照表

| 在這個狀態 | 輸入 | 結果 | 下一個狀態 |
|---|---|---|---|
| idle | 按住連接點 | 開始拉線 | armed → dragging |
| idle | 選節點 + R | 鍵盤拉線；focus 到第一個候選目標 | targeting |
| dragging | 移到節點上 | 吸附；自己或已有同一條關聯的節點不吸附，顯示禁止游標 | targeting |
| dragging | 放開在空白處 | 取消 | idle |
| dragging | 拖到畫布邊緣 | 自動平移（每 16ms 8px） | dragging |
| targeting | 方向鍵 | 在候選目標間移動（最近的優先） | targeting |
| targeting | 放開 / Enter | 建立關聯，打開說明輸入框 | labeling |
| labeling | Enter | 儲存說明（可留白） | committed |
| labeling | Esc | 保留關聯、不寫說明 | committed |
| armed / dragging / targeting | Esc | 取消 | idle |
| committed | 點線或標籤 | 選取；出現「改說明」「刪除」 | committed |
| committed（已選取） | Delete | 刪除；5 秒內可復原 | idle |
| suggested | 確認 | 變成實線；建議匣那筆標為已接受 | committed |
| suggested | 移除 | 消失；建議匣那筆標為已忽略 | idle |
| idle | 拖曳空白處 | 平移畫布 | idle |

### 規則

- 同一對端點只能有一條關聯（不分方向）。
- 「關聯」圖層關閉時不能拉線，也不顯示連接點。
- 平板長按節點 500ms 進入 armed；手機沒有地圖。
- 唯讀身分看得到關聯，沒有連接點與刪除。
- 關聯變更不另外通知 AI；下一輪預覽裡看得到「關聯 n 條」。
- 減少動態效果時，吸附與自動平移不做動畫。
