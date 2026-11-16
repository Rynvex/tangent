/**
 * B21: combined exports as a browser extension saves them (`exportType:
 * "combined"`, a whole Gemini folder in one `dialogue`, every prompt captured
 * twice behind 「你說了」, every reply behind 「Gemini 說了」, no per-message
 * times, one date for the file). The real file is the user's; these are
 * written to look like it.
 */

export interface CombinedEntry {
  role: "user" | "assistant";
  content: string;
  id: string;
}

export interface CombinedExport {
  exportType: "combined";
  timestamp: string;
  projectName: string;
  dialogue: CombinedEntry[];
}

const prompt = (text: string) => `你說了 ${text}  ${text}`;
const reply = (text: string) => `Gemini 說了${text}`;

/** The four rounds of the user's file: CPU cooling, Firebase, then PRD and a PRD follow-up about algorithms. */
const SAMPLE_ROUNDS: ReadonlyArray<readonly [string, string]> = [
  [
    "如果電腦平常都不關, CPU散熱多久換一次比較好?",
    "對於 24 小時不關機的電腦，建議 每 1.5 年至 2 年 更換一次 CPU 散熱膏。\n\n長時間高溫會讓散熱膏乾裂、導熱變差，可以觀察以下徵兆：\n1. 待機溫度比剛裝機時高出 10°C 以上。\n2. 風扇轉速明顯變快、噪音變大。\n3. 負載時頻繁降頻。\n如果是水冷，也要順便檢查冷排與水泵；氣冷則記得清掉散熱鰭片上的灰塵。\n    \n    \n    編輯影像",
  ],
  [
    "firebase是什麼?",
    "Firebase 是 Google 提供的 BaaS（Backend as a Service）雲端平台，讓開發者不用自己架後端就能做出 App。\n\n主要服務：\n- Authentication：Email、Google、Apple 登入\n- Firestore / Realtime Database：即時同步的 NoSQL 資料庫\n- Cloud Functions：寫在雲端的後端程式\n- Hosting、Cloud Storage、Cloud Messaging（推播）\n適合 MVP、小團隊與需要即時同步的應用；缺點是資料查詢較受限，規模大時費用要留意。",
  ],
  [
    "PRD一般是對內還對外的?",
    "PRD（Product Requirement Document，產品需求文件）一般是 **對內** 的文件。\n\n它寫給團隊裡的工程師、設計師、QA 與專案經理，說明這個產品要解決什麼痛點、目標使用者是誰、功能範圍與驗收標準。\n對外溝通（客戶、投資人）通常改用產品簡介、Pitch Deck 或 Release Notes，不會直接給完整的 PRD。",
  ],
  [
    "如果有UI的話PRD可以畫出來並加入互動功能, 但如果是algorithm呢?",
    "演算法類的 PRD 沒有畫面可以畫，重點改成把「輸入、輸出、限制」寫清楚：\n1. 輸入資料的格式與範圍、輸出的意義。\n2. 效能指標：準確率、延遲、資源上限。\n3. 邊界情況與失敗時的處理。\n可以附上範例資料與預期結果當成驗收用例，或用流程圖、虛擬碼代替 UI 原型。",
  ],
];

const entries = (rounds: ReadonlyArray<readonly [string, string]>, offset = 0): CombinedEntry[] =>
  rounds.flatMap(([question, answer], index) => [
    { role: "user" as const, content: prompt(question), id: `${offset + index * 2}-user` },
    { role: "assistant" as const, content: reply(answer), id: `${offset + index * 2 + 1}-assistant` },
  ]);

/** `Gemini-Combined_雜談-2026-11-03.json` as far as the user showed it, with the last reply. */
export function geminiCombinedSample(): CombinedExport {
  return { exportType: "combined", timestamp: "2026-11-03", projectName: "雜談", dialogue: entries(SAMPLE_ROUNDS) };
}

/** Topics of the long file: an English name and a Chinese one, shared by nothing else. */
const LONG_TOPICS: ReadonlyArray<readonly [string, string]> = [
  ["Docker", "容器"], ["Kubernetes", "叢集"], ["PostgreSQL", "索引"], ["Redis", "快取"], ["Nginx", "反向代理"],
  ["Rust", "所有權"], ["Golang", "協程"], ["React", "元件"], ["TypeScript", "型別"], ["GraphQL", "查詢語言"],
  ["Kafka", "訊息佇列"], ["Terraform", "基礎設施"], ["Linux", "核心"], ["Bluetooth", "藍牙"], ["Wi-Fi", "路由器"],
  ["Python", "直譯器"], ["Excel", "樞紐分析"], ["Photoshop", "圖層"], ["Arduino", "感測器"], ["NAS", "硬碟"],
  ["SSD", "固態"], ["OLED", "螢幕"], ["Espresso", "咖啡豆"], ["Sourdough", "酵母"], ["Marathon", "跑步"],
];

/** One topic's rounds: an opening question, then follow-ups that name the topic or open like follow-ups. */
function topicRounds([name, word]: readonly [string, string], rounds: number): Array<readonly [string, string]> {
  return Array.from({ length: rounds }, (_, n): readonly [string, string] => {
    const question = n === 0 ? `${name} ${word}是什麼?` : n % 3 === 0 ? `那第 ${n} 點可以再展開嗎?` : `${name} 的${word}第 ${n} 點要怎麼設定?`;
    return [question, `${name}（${word}）第 ${n} 點：先確認版本，再照步驟調整，最後檢查結果。`];
  });
}

/** A combined export of `topics` topics of `rounds` rounds each (25 × 15 rounds: 750 messages). */
export function longCombinedExport(topics = LONG_TOPICS.length, rounds = 15): CombinedExport {
  const all = LONG_TOPICS.slice(0, topics).flatMap((topic) => topicRounds(topic, rounds));
  return { exportType: "combined", timestamp: "2026-11-03", projectName: "雜談", dialogue: entries(all) };
}

/**
 * B22: A → B → A → C → A → B in six rounds: CPU cooling (#1, #3, #5), Firebase (#2, #6) and a water-cooling detour
 * (#4). The server's domain/import_analyze_test.go uses the same text (keep them equal).
 */
export const INTERLEAVED_ROUNDS: ReadonlyArray<readonly [string, string]> = [
  ["如果電腦平常都不關, CPU散熱多久換一次散熱膏比較好?", "建議每 1.5 年到 2 年更換一次 CPU 散熱膏。長時間高溫會讓散熱膏乾裂、導熱變差。"],
  ["firebase是什麼?", "Firebase 是 Google 提供的 BaaS 雲端平台，讓開發者不用自己架後端就能做出 App。"],
  ["散熱膏可以改用相變導熱片 PTM7950 嗎?", "PTM7950 是相變導熱片，長期使用不會乾掉，適合不關機的電腦。"],
  ["水冷排要裝在機殼上方還是前方?", "冷排裝在上方當排氣比較好，熱空氣會往上走。"],
  ["散熱膏換完之後 CPU 待機溫度還是很高怎麼辦?", "可以檢查散熱器是否鎖緊，風扇有沒有正常運轉。"],
  ["Firebase 的免費方案有什麼限制?", "Spark 免費方案每天有讀寫次數上限，超過就要升級 Blaze 按量計費。"],
];

/** One conversation (a generic JSON export, undated) holding the six interleaved rounds. */
export function interleavedConversation(): { title: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  return {
    title: "電腦雜談",
    messages: INTERLEAVED_ROUNDS.flatMap(([question, answer]) => [
      { role: "user" as const, content: question },
      { role: "assistant" as const, content: answer },
    ]),
  };
}

/** The six interleaved rounds as a combined export (threaded into three conversations when parsed). */
export function interleavedCombinedExport(): CombinedExport {
  return { exportType: "combined", timestamp: "2026-11-03", projectName: "雜談", dialogue: entries(INTERLEAVED_ROUNDS) };
}
