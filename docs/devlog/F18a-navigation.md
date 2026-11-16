# F18a · 上一頁與深連結（demo app）

> 2026-11-13。工單 §2.4 的獨立部分：網址跟著畫面走，上一頁、下一頁、重新整理、貼上連結都回得去。
> F18 其餘部分（§1 client、§2.1–§2.3）依賴後端 B23，不在這一步。只改 `web/`，沒有動 Go。

## 做了什麼

- 網址是 `?line=<lineId>&m=<messageId>`（`m` 選填，沒有 `line` 就忽略）。其他參數（`frame`、`focus`、`theme`、`lang`、`features`…）原樣保留。
- **換線 `pushState`，同一條線內換訊息 `replaceState`**，沒變就不寫。規則在 `frame/url-state.ts` 的 `historyActionFor`。
- `popstate`：把畫面帶回網址指的線與訊息；這條路徑不寫歷史（不會迴圈）。初次載入不推歷史。
- 重新整理回到同一條線：預設顯示「清單第一篇」時，也用 `replaceState` 把那條線寫進網址（`useShownLineInAddress`），
  之後清單順序變了，重新整理仍回到原來那篇。
- 線不存在（刪除、清除、手打錯）：沿用 F7 的 `useConversationDeletion`（`line_not_found` → 離開），但離開時改用 `replace`
  （不加歷史），回清單第一篇；不會停在錯誤畫面。
- `@tangent/react` 沒有改，沒有碰 `window.history`，也沒有新增 `onNavigate`（demo 內部接路由就夠，沒有宿主需要它）。

## 檔案

| 檔案 | 內容 |
|---|---|
| `frame/url-state.ts` + `.test.ts` | 純邏輯：`readUrlState`、`urlWithState`、`historyActionFor`。 |
| `frame/navigation.ts` + `.test.tsx` | `useNavigation`（從 `shell.tsx` 搬出，多了 `replace`、popstate、寫網址）與 `useShownLineInAddress`。jsdom 的 history 測 push/replace/back/forward。 |
| `frame/params.ts` | `DemoParams` 多 `message`（`?m=`），沿用 `readUrlState`。 |
| `shell.tsx` | 只接線，見下。 |
| `e2e/tests/navigation.spec.ts` | 進支線 → 上一頁 → 下一頁；重新整理；`line`＋`m` 直接到那則訊息；不存在的線回第一篇且不多一筆歷史。 |

`shell.tsx` 的改動（共 5 處）：① 刪掉內部的 `useNavigation`（改 import `frame/navigation`，順便刪掉不再用的 `Navigate`、`MessageFocus` import）；
② `useNavigation({ line, message })`；③ 解構多拿 `replace`；④ 一行 `useShownLineInAddress(selected)`；⑤ `leave` 裡 `navigate(next)` 改成 `replace(next)`。

## 和工單不同的地方（都是為了讓「貼上網址直接到那則訊息」與「不能卡住」成立）

1. **`QueryClient` 不重試 `line_not_found`**（`main.tsx`）。預設會重試 3 次（退避約 7 秒），網址指向不存在的線時畫面會空白等 7 秒才離開。
2. **深連結要在畫面還在排版時成功捲到訊息**，原本的 `useMessageFocus` 做不到（它只在已開著的線上被測過）：
   - `focus.ts`：開線後的**第一次**跳轉用 `behavior: "auto"`（之後同一條線內仍是平滑捲動），並多一個選填 `onJump` 回呼。
   - `hooks.ts`：`useStickToBottom` 多回傳 `release()`（放掉「跟著底部」）；RO 自己捲到底後也記下 `lastTop`。
   - `conversation-view.tsx`：兩行，把 `release` 傳給 `useMessageFocus`。
   - 原因：訊息列用 `content-visibility: auto`，跳轉當下下方的列還是預估高度，目標落在「離底部 48px 內」→ 仍視為釘在底部 →
     列長成真實高度後被拉回底部。偵錯時看到 `scrollTop` 被 ResizeObserver 一再設回底部。跨線的跳轉（搜尋結果、卡片連結）本來也有同樣的風險，現在一併受益。
3. 預設顯示第一篇時也會把 `line` 寫進網址（工單只說「重新整理後回到同一條線」，沒說怎麼做）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| `packages/client` `npx vitest run` | 91 檔 1252 測試通過 |
| `packages/react` `npx vitest run` | 96 檔 1028 測試通過 |
| `apps/demo` `npx vitest run` | 47 檔 292 測試通過（新增 url-state 12、navigation 14、focus 4） |
| `packages/fonts` `npx vitest run` | 1 檔 10 測試通過 |
| `pnpm -C web build` | 通過；主 JS gzip **170.07 kB → 170.51 kB**（vite 回報的 kB，上限 172） |
| e2e（mock project，`--workers=2`） | `navigation.spec.ts` 4/4；另跑受影響的 conversation、branches、search、f7、embed、f12、focus、f13、f8 全綠（見下方 f8 的備註） |

沒跑：整套 e2e、`api` / `api-core` project（留給協調者）。

備註：`f8.spec.ts` 的 S6 在機器高負載時前兩次整檔跑失敗（逾時 30 秒），單獨跑與之後連續三次整檔跑都通過；
S6 本身只開支線並送出，沒有碰到這次改的東西，判斷是負載造成，但協調者補跑整套時請留意。

## 留下的項目

- 上一頁只回到「線」，不還原側欄分頁、專注模式的地圖狀態、開著的對話框（開著的流程 `flow` 換線時不會被關掉，與換線前行為相同）。
- `onNavigate` 沒做；若 宿主 嵌入時要接自己的路由，再加（只新增選填 props）。
- 網址的 `m` 在同線被捲動後不會更新（只在「跳到訊息」時寫），重新整理會回到最後一次跳轉的訊息。
