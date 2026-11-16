package domain

import (
	"slices"
	"testing"
)

// B18.1: the suggested Chinese tags are joined back into words and
// fragments are dropped, the same way as the web client's
// filterSuggestedTags (web/packages/client/src/suggested-tags.test.ts has
// the same cases).

func TestDecompose_TitleTopicWords(t *testing.T) {
	cases := map[string][]string{
		"微分幾何在物理研究中的應用":       {"微分幾何", "物理研究", "應用"},
		"Postgres MVCC 與索引設計": {"索引設計"},
		"為什麼容器連不上宿主機？":        {"容器連不上宿主機"},
		"微分幾何在研究什麼?":          {"微分幾何", "研究"},
		"一二三四五六七八九":           {},
		"":                    {},
	}
	for title, want := range cases {
		if got := titleTopicWords(title); !slices.Equal(got, want) {
			t.Errorf("titleTopicWords(%q) = %q, want %q", title, got, want)
		}
	}
}

func TestDecompose_CleanSuggestedTagsMatchesTheWebClient(t *testing.T) {
	set := func(tags ...string) map[string]bool {
		out := map[string]bool{}
		for _, tag := range tags {
			out[tag] = true
		}
		return out
	}
	cases := []struct {
		name      string
		raw       []string
		title     string
		used, own map[string]bool
		want      []string
	}{
		{"pairs of a title word are joined, fragments across words dropped", []string{"微分", "分幾", "幾何", "何在", "研究"}, "微分幾何在物理研究中的應用", nil, nil, []string{"微分幾何", "研究"}},
		{"a chain the title does not name is joined", []string{"微分", "分幾", "幾何", "何在", "研究"}, "一些筆記", nil, nil, []string{"微分幾何", "研究"}},
		{"ASCII words and used tags are kept, own tags left out", []string{"postgresql", "機制", "docker", "容器", "raid10"}, "PostgreSQL MVCC 與鎖定機制討論", set("容器"), set("docker"), []string{"postgresql", "機制", "容器", "raid10"}},
		{"pairs at a question word are dropped", []string{"索引", "要怎", "租戶"}, "Postgres MVCC 與索引設計", nil, nil, []string{"索引", "租戶"}},
		{"normalised, without repeats", []string{"#Postgres", "postgres", " ", "MVCC"}, "", nil, nil, []string{"postgres", "mvcc"}},
		{"a used tag is kept even when it looks like a fragment", []string{"何在"}, "微分幾何在研究", set("何在"), nil, []string{"何在"}},
		{"a chain stops at six characters", []string{"一二", "二三", "三四", "四五", "五六", "六七", "七八"}, "", nil, nil, []string{"一二三四五六", "六七八"}},
		{"a joined word that is an own tag is left out", []string{"微分", "分幾", "幾何", "研究"}, "微分幾何在研究什麼?", nil, set("微分幾何"), []string{"研究"}},
		{"a dropped fragment does not break a chain (so cleaning again changes nothing)", []string{"微分", "何在", "分幾"}, "", nil, nil, []string{"微分幾"}},
		{"an own tag does not break a chain either", []string{"甲乙", "乙丙", "丙丁"}, "", nil, set("乙丙"), []string{"甲乙", "丙丁"}},
	}
	for _, c := range cases {
		got := cleanSuggestedTags(c.raw, c.title, orEmpty(c.used), orEmpty(c.own), 100)
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
		// Cleaning again changes nothing (the web client cleans the answer
		// once more).
		if again := cleanSuggestedTags(got, c.title, orEmpty(c.used), orEmpty(c.own), 100); !slices.Equal(again, got) {
			t.Errorf("%s: not idempotent: %q then %q", c.name, got, again)
		}
	}
	if got := cleanSuggestedTags([]string{"a1", "b2", "c3"}, "", nil, nil, 2); !slices.Equal(got, []string{"a1", "b2"}) {
		t.Errorf("limit: %q", got)
	}
}

func orEmpty(m map[string]bool) map[string]bool {
	if m == nil {
		return map[string]bool{}
	}
	return m
}

func noFragments(t *testing.T, tags []string) {
	t.Helper()
	for _, fragment := range []string{"分幾", "何在", "在研", "究什", "微分", "幾何"} {
		if slices.Contains(tags, fragment) {
			t.Fatalf("tags %q carry the fragment %q", tags, fragment)
		}
	}
}

func TestDecompose_ChineseTagsAreWholeWords(t *testing.T) {
	// The work order's example: a conversation about 微分幾何 in physics.
	plan := BuildDecomposePlan(DecomposeInput{Title: "微分幾何在物理研究中的應用", Messages: decomposeLine(
		"微分幾何在物理上有哪些應用？有哪些研究方向？",
		"微分幾何是廣義相對論的語言：時空是彎曲的流形，重力就是曲率。不少研究也用它描述規範場。",
		"那微分幾何在凝態的研究呢？",
		"拓樸絕緣體的研究會用到纖維叢與陳數。",
	)})
	noFragments(t, plan.SuggestedTags)
	if !slices.Contains(plan.SuggestedTags, "微分幾何") || !slices.Contains(plan.SuggestedTags, "研究") {
		t.Fatalf("tags = %q", plan.SuggestedTags)
	}
	// The dev server's real conversation (its first two messages, cut).
	plan = BuildDecomposePlan(DecomposeInput{Title: "微分幾何在研究什麼?", Messages: decomposeLine(
		"微分幾何在研究什麼?",
		"微分幾何是用微積分與線性代數的工具，研究**曲線、曲面以及更一般的「流形」的形狀與性質**。\n\n**核心問題**\n- **彎曲程度**：一個空間有多彎？例如曲線的曲率、曲面的高斯曲率。",
		"微分幾何在CV領域有什麼用途或應用?",
		"微分幾何在 CV（電腦視覺）中主要出現在「形狀、變換、不確定性」這幾類問題上。\n\n**1. 3D 幾何與曲面處理**\n- **網格／點雲分析**：用曲率（平均曲率、高斯曲率）做特徵點偵測。",
	)})
	noFragments(t, plan.SuggestedTags)
	if len(plan.SuggestedTags) < 2 || plan.SuggestedTags[0] != "微分幾何" || plan.SuggestedTags[1] != "研究" || len(plan.SuggestedTags) > DecomposeMaxTags {
		t.Fatalf("tags = %q", plan.SuggestedTags)
	}
	// A tag the tenant uses is suggested as it is; the line's own is not.
	plan = BuildDecomposePlan(DecomposeInput{Title: "微分幾何在研究什麼?", Tags: []string{"研究"}, TenantTags: []string{"幾何"}, Messages: decomposeLine(
		"微分幾何在研究什麼?", "微分幾何研究曲面的曲率。",
	)})
	if !slices.Contains(plan.SuggestedTags, "幾何") || slices.Contains(plan.SuggestedTags, "研究") {
		t.Fatalf("tags with tenant and own tags = %q", plan.SuggestedTags)
	}
}

// B19: a tenant tag inside a title topic word ("幾何" in "微分幾何") takes
// part in the join, wherever it is ranked, so the word is never cut short to
// "微分幾"; the tenant tag is still kept on its own.
func TestDecompose_ATenantTagInsideATitleWordNeverCutsItShort(t *testing.T) {
	title := "微分幾何在物理研究中的應用"
	used := map[string]bool{"幾何": true}
	cases := map[string][]string{
		"the tenant tag after 微分":  {"微分", "分幾", "幾何", "研究"},
		"the tenant tag before 微分": {"幾何", "微分", "分幾", "研究"},
		"the tenant tag last":      {"微分", "分幾", "研究", "幾何"},
	}
	for name, raw := range cases {
		got := cleanSuggestedTags(raw, title, used, map[string]bool{}, 100)
		if !slices.Contains(got, "微分幾何") || slices.Contains(got, "微分幾") || slices.Contains(got, "分幾") {
			t.Errorf("%s: got %q, want 微分幾何 and never 微分幾", name, got)
		}
		if !slices.Contains(got, "幾何") || !slices.Contains(got, "研究") {
			t.Errorf("%s: got %q, want the tenant tag 幾何 and 研究 kept", name, got)
		}
		if again := cleanSuggestedTags(got, title, used, map[string]bool{}, 100); !slices.Equal(again, got) {
			t.Errorf("%s: not idempotent: %q then %q", name, got, again)
		}
	}
	// The whole plan: the tenant uses 幾何, the conversation is about 微分幾何.
	plan := BuildDecomposePlan(DecomposeInput{Title: title, TenantTags: []string{"幾何"}, Messages: decomposeLine(
		"微分幾何在物理上有哪些應用？有哪些研究方向？",
		"微分幾何是廣義相對論的語言，不少研究也用它描述規範場。",
	)})
	if !slices.Contains(plan.SuggestedTags, "微分幾何") || slices.Contains(plan.SuggestedTags, "微分幾") {
		t.Fatalf("plan tags = %q", plan.SuggestedTags)
	}
}
