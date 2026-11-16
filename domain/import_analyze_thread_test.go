package domain

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// The weighted threading (import_analyze_weights.go): a unit joins the
// cluster whose questions and recent answers share enough weighted words
// with its question, going on with the current one being cheaper than
// coming back to an earlier one; a follow-up opening, a report-back or a
// pointer back stays unless another cluster claims the unit; 另外 / 對了
// open a new topic; the first node is a chapter only when it is a core
// topic.

func threadKeys(t *testing.T, units []ImportAnalyzeUnit) [][]string {
	t.Helper()
	plan, err := AnalyzeImportDeterministic(ImportAnalyzeInput{Units: units})
	if err != nil {
		t.Fatal(err)
	}
	coversEveryUnit(t, plan, units)
	out := [][]string{}
	for _, node := range plan.Nodes {
		out = append(out, node.UnitKeys)
	}
	return out
}

func round(key, question, answer string) ImportAnalyzeUnit {
	return ImportAnalyzeUnit{Key: key, Question: question, Answer: answer, MessageCount: 2}
}

// 另外 and 對了 open a new topic even right after a reply that shares a word.
func TestThread_ShiftCuesOpenANewTopic(t *testing.T) {
	units := []ImportAnalyzeUnit{
		round("a1", "Postgres 的 MVCC 對寫入量大的表有什麼影響?", "每次 UPDATE 都會產生新版本，舊版本等 VACUUM 清掉，所以要注意膨脹。"),
		round("a2", "要怎麼監控膨脹?", "看 pg_stat_user_tables 的 n_dead_tup。"),
		round("b1", "另外，即時通知要用 WebSocket 還是 SSE?", "單向推播用 SSE 就夠了。"),
		round("b2", "SSE 斷線時怎麼補送?", "用 Last-Event-ID 從最後一筆之後補送。"),
		round("c1", "對了，表膨脹的 VACUUM 要手動跑嗎?", "autovacuum 通常夠用。"),
	}
	got := threadKeys(t, units)
	// c1 names 膨脹 and VACUUM, both of a's words: a shift cue does not forbid a join by words, it only stops the follow-up rule.
	want := [][]string{{"a1", "a2", "c1"}, {"b1", "b2"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nodes = %v, want %v", got, want)
	}
}

// A question opening with 那 about a brand-new topic does not stay; one that
// touches the current topic does; a short report-back stays.
func TestThread_FollowUpsStayOnlyWhenTheyTouchTheTopic(t *testing.T) {
	units := []ImportAnalyzeUnit{
		round("a1", "asyncio 裡面呼叫 requests 會卡住嗎?", "會，requests 是同步阻塞的，要改用 aiohttp 或 to_thread。"),
		round("a2", "那如果一定要用 requests 呢?", "用 asyncio.to_thread 丟到執行緒池。"),
		round("b1", "那我想問 Docker 的 volume 要怎麼掛?", "用 -v 或 compose 的 volumes。"),
		round("b2", "掛好了，但權限是 root。", "加 user 參數或 chown。"),
	}
	got := threadKeys(t, units)
	want := [][]string{{"a1", "a2"}, {"b1", "b2"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nodes = %v, want %v", got, want)
	}
}

// The cues: a shift cue at the start or just after an opener, in either
// language; a report-back is a short statement, not a bare topic nor an order.
func TestThread_Cues(t *testing.T) {
	for _, q := range []string{"另外，即時通知要用 SSE?", "那我想問 Docker 的 volume?", "嗯對了，VACUUM 要手動跑嗎?", "By the way, what about X?", "Unrelated question: is Go fast?"} {
		if !startsAsShift(q) {
			t.Errorf("%q is a shift", q)
		}
	}
	if startsAsShift("那如果一定要用 requests 呢?") {
		t.Error("那如果 is no shift")
	}
	for _, q := range []string{"確實是 Seq Scan。", "p95 降到 120ms 了。", "找到了，卡在 orders 表的外鍵檢查。", "It works now."} {
		if !isReportBack(q) {
			t.Errorf("%q is a report-back", q)
		}
	}
	for _, q := range []string{"幫我寫一個 Docker compose 範例。", "dead tuples 很少嗎?", "Redis 快取", "Kafka 佇列", "Why is the sky blue", "Redis 的持久化是什麼", "Redis 持久化 RDB 與 AOF 差在哪", strings.Repeat("一句超過三十個字的敘述", 3) + "。"} {
		if isReportBack(q) {
			t.Errorf("%q is no report-back", q)
		}
	}
	// An order carried out is a report-back after all.
	if !isReportBack("寫好了，但跑不起來。") || !isReportBack("Created the table, works now.") {
		t.Error("寫好了 and 'works now' are report-backs")
	}
	// A weak pointer back (也, 再) counts only in a short question.
	if !hasReferent("pg_hba.conf 也得改嗎?") || hasReferent("我也許會改用 Redis 來做快取，因為那些持久化策略比較適合這類大型專案的需求") {
		t.Error("也 points back only in a short question")
	}
}

// A new topic asked without a question mark does not stick to the old one.
func TestThread_AQuestionWithoutAMarkIsStillAQuestion(t *testing.T) {
	units := []ImportAnalyzeUnit{
		round("a1", "Docker 容器是什麼?", "Docker 把應用程式包成容器。"),
		round("b1", "Why is the sky blue", "Rayleigh scattering."),
		round("c1", "Redis 持久化 RDB 與 AOF 差在哪", "RDB 是快照，AOF 是日誌。"),
	}
	got := threadKeys(t, units)
	want := [][]string{{"a1"}, {"b1"}, {"c1"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nodes = %v, want %v", got, want)
	}
}

// A word every unit uses (設定 in all of them) weighs half; an ASCII name
// weighs more than a Han pair; a title word weighs half.
func TestThread_CommonWordsWeighNothing(t *testing.T) {
	units := []ImportAnalyzeUnit{
		round("a1", "Nginx 的反向代理設定要怎麼寫?", "在 server 區塊加 location 與 proxy_pass 設定。"),
		round("b1", "Rust 的所有權設定是什麼?", "所有權是編譯期的記憶體設定規則。"),
		round("a2", "Nginx 設定的 proxy_pass 要加斜線嗎?", "看路徑要不要被取代。"),
		round("b2", "Rust 借用的設定錯誤怎麼修?", "縮短借用的範圍。"),
	}
	got := threadKeys(t, units)
	want := [][]string{{"a1", "a2"}, {"b1", "b2"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nodes = %v, want %v", got, want)
	}
	weights := analyzeTermWeights("Nginx 與 Rust 雜談", units)
	if weights["設定"] != analyzeHanWeight*analyzeCommonFactor || weights["nginx"] != analyzeASCIIWeight*analyzeTitleFactor || weights["反向"] != analyzeHanWeight || weights["proxy_pass"] != analyzeASCIIWeight {
		t.Fatalf("weights: 設定 %.2f nginx %.2f 反向 %.2f proxy_pass %.2f", weights["設定"], weights["nginx"], weights["反向"], weights["proxy_pass"])
	}
}

// Small talk at the start is not the chapter: the first core topic is.
func TestThread_OpeningSmallTalkIsNotTheChapter(t *testing.T) {
	units := []ImportAnalyzeUnit{
		round("s1", "嗨，今天天氣真好", "是啊，適合出門走走。"),
		round("a1", "Kubernetes 的 pod 一直重啟怎麼查?", "先看 kubectl describe pod 的事件。"),
		round("a2", "describe 說 OOMKilled，要怎麼調?", "提高 memory limit 或找記憶體洩漏。"),
		round("z1", "咖啡豆怎麼保存?", "密封、避光、放陰涼處。"),
	}
	plan, err := AnalyzeImportDeterministic(ImportAnalyzeInput{Units: units})
	if err != nil {
		t.Fatal(err)
	}
	roles := []string{}
	for _, node := range plan.Nodes {
		roles = append(roles, node.Key+":"+node.Role)
	}
	if want := []string{"s1:standalone", "a1:chapter", "z1:standalone"}; !reflect.DeepEqual(roles, want) {
		t.Fatalf("roles = %v, want %v", roles, want)
	}
	// A conversation with no core topic still has a chapter: its largest node.
	plan, _ = AnalyzeImportDeterministic(ImportAnalyzeInput{Units: units[:1]})
	if plan.Nodes[0].Role != ImportRoleChapter {
		t.Fatalf("a lone unit = %+v", plan.Nodes[0])
	}
}

// Going on with the current topic takes one Han word (機殼 right after the
// 機殼 question); coming back to an earlier topic takes more. A long
// single-topic conversation stays one node.
func TestThread_StayingIsCheaperThanComingBack(t *testing.T) {
	units := []ImportAnalyzeUnit{
		round("c1", "手沖咖啡的水溫要幾度?", "淺焙 92 到 94 度。"),
		round("c2", "去日本旅遊需要辦簽證嗎?", "短期觀光免簽。"),
		round("a1", "機殼風道要前進後出，還是下進上出?", "大部分直立機殼用前進後出加頂部排風最穩。"),
		round("a2", "機殼正壓和負壓哪個比較不容易積灰?", "正壓比較不容易積灰。"),
		round("b1", "Supabase 的免費額度夠個人專案用嗎?", "免費方案有 500 MB 資料庫。"),
		round("a3", "機殼濾網多久清一次?", "一個月一次。"),
	}
	got := threadKeys(t, units)
	// a3 shares only 機殼 with a, which is enough to go on but not to come back.
	want := [][]string{{"c1"}, {"c2"}, {"a1", "a2"}, {"b1"}, {"a3"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nodes = %v, want %v", got, want)
	}
	long := []ImportAnalyzeUnit{}
	for i := range 40 {
		long = append(long, round(fmt.Sprintf("d%d", i), fmt.Sprintf("Docker 第 %d 題", i), "ok"))
	}
	if got := threadKeys(t, long); len(got) != 1 {
		t.Fatalf("a long Docker conversation is %d nodes", len(got))
	}
}

// The evaluation set's floor: the heuristic must keep at least this much
// precision overall (over-merging was the complaint), without losing
// everything on recall.
func TestImportAnalyzeEval_HeuristicMeetsTheFloor(t *testing.T) {
	total := ImportAnalyzeScore{}
	for _, sample := range loadAnalyzeEvalSamples(t) {
		plan, err := AnalyzeImportDeterministic(sample.Input())
		if err != nil {
			t.Fatal(err)
		}
		total = total.Add(ScoreImportAnalyzePlan(plan, sample.Gold))
	}
	if total.Precision() < 0.85 || total.Recall() < 0.5 {
		t.Fatalf("P %.2f R %.2f, want P >= 0.85 and R >= 0.5", total.Precision(), total.Recall())
	}
}
