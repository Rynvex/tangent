package seed

import (
	"math/rand/v2"
	"strings"

	"github.com/google/uuid"
)

// Words the generated messages are made of: English, Traditional Chinese and
// both mixed, so search has every kind of text to look through.
var (
	englishWords = strings.Fields("the plan budget cache latency deploy review branch summary trip Kyoto ryokan train " +
		"database index query benchmark release roadmap customer feedback design token prompt model search ranking " +
		"conclusion decision option trade-off risk schedule team week spring autumn hotel price measure")
	chinesePhrases = strings.Fields("分岔對話 背景說明 預算 快取 延遲 部署 審查 支線 摘要 旅行 京都 旅館 火車 資料庫 索引 查詢 " +
		"效能 發佈 路線圖 客戶 回饋 設計 模型 搜尋 排序 結論 決定 選項 取捨 風險 時程 團隊 春天 秋天 價格 量測")
)

// sentence is a message body of about words units in one of three styles.
func sentence(rng *rand.Rand, words int) string {
	var b strings.Builder
	style := rng.IntN(3)
	for i := range words {
		switch {
		case style == 0 || (style == 2 && rng.IntN(2) == 0):
			if i > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(englishWords[rng.IntN(len(englishWords))])
		default:
			b.WriteString(chinesePhrases[rng.IntN(len(chinesePhrases))])
			if rng.IntN(6) == 0 {
				b.WriteString("，")
			}
		}
	}
	return b.String() + "."
}

// newID is a version-4 UUID drawn from rng, so a seed gives the same ids.
func newID(rng *rand.Rand) uuid.UUID {
	var id uuid.UUID
	for i := range id {
		id[i] = byte(rng.UintN(256))
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return id
}
