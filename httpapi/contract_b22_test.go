package httpapi_test

import (
	"fmt"
	"net/http"
)

// b22Units are six rounds of A → B → A → C → A → B (CPU cooling, Firebase,
// a water-cooling detour), as the client sends them for an analysis.
func b22Units() []map[string]any {
	rounds := [][2]string{
		{"如果電腦平常都不關, CPU散熱多久換一次散熱膏比較好?", "建議每 1.5 年到 2 年更換一次 CPU 散熱膏。長時間高溫會讓散熱膏乾裂、導熱變差。"},
		{"firebase是什麼?", "Firebase 是 Google 提供的 BaaS 雲端平台，讓開發者不用自己架後端就能做出 App。"},
		{"散熱膏可以改用相變導熱片 PTM7950 嗎?", "PTM7950 是相變導熱片，長期使用不會乾掉，適合不關機的電腦。"},
		{"水冷排要裝在機殼上方還是前方?", "冷排裝在上方當排氣比較好，熱空氣會往上走。"},
		{"散熱膏換完之後 CPU 待機溫度還是很高怎麼辦?", "可以檢查散熱器是否鎖緊，風扇有沒有正常運轉。"},
		{"Firebase 的免費方案有什麼限制?", "Spark 免費方案每天有讀寫次數上限，超過就要升級 Blaze 按量計費。"},
	}
	units := make([]map[string]any, 0, len(rounds))
	for i, r := range rounds {
		units = append(units, map[string]any{"key": fmt.Sprintf("s1#turn-%d", i+1), "question": r[0], "answer": r[1], "messageCount": 2})
	}
	return units
}

// b22 asks for the analysis of an interleaved conversation (the fake runner's
// reply is no plan, so the deterministic analyzer answers).
func (f *flow) b22() {
	f.call("lines.import_analyze", http.StatusOK, http.MethodPost, "/lines/import-analyze", map[string]any{"title": "雜談", "units": b22Units()})
}
