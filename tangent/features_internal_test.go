package tangent

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// stubFeature is a feature for testing the registry.
type stubFeature struct {
	name       string
	requires   []string
	configured Mode
	attach     func(*registry)
	registered *int
}

func (f stubFeature) Name() string       { return f.name }
func (f stubFeature) Requires() []string { return f.requires }
func (f stubFeature) AI() bool           { return false }
func (f stubFeature) mode() Mode {
	if f.configured == ModeOff {
		return ModeAuto
	}
	return f.configured
}
func (f stubFeature) register(r *registry) {
	if f.registered != nil {
		*f.registered++
	}
	if f.attach != nil {
		f.attach(r)
	}
}

func TestRegistry_EmptyIsValidAndFeaturesRegisterInOrder(t *testing.T) {
	r, err := buildRegistry(nil)
	if err != nil || len(r.features) != 0 {
		t.Fatalf("empty registry: %v", err)
	}
	count := 0
	r, err = buildRegistry([]Feature{
		stubFeature{name: "notes", registered: &count},
		stubFeature{name: "summary", requires: []string{"notes"}, registered: &count},
	})
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 || r.features[0].Name() != "notes" || r.modes["summary"] != ModeAuto {
		t.Fatalf("count=%d features=%v", count, r.features)
	}
}

func TestRegistry_RefusesMissingDependenciesDuplicatesAndBadNames(t *testing.T) {
	selector := func(r *registry) { r.setHistorySelector(nil) }
	handler := func(r *registry) { r.addJobHandler("x", jobHandler{}) }
	cases := []struct {
		features []Feature
		want     string
	}{
		{[]Feature{stubFeature{name: "summary", requires: []string{"chapters"}}}, "requires"},
		{[]Feature{stubFeature{name: "notes"}, stubFeature{name: "notes"}}, "twice"},
		{[]Feature{stubFeature{name: " "}}, "no name"},
		{[]Feature{nil}, "nil"},
		{[]Feature{stubFeature{name: "a", attach: selector}, stubFeature{name: "b", attach: selector}}, "only one"},
		{[]Feature{stubFeature{name: "a", attach: handler}, stubFeature{name: "b", attach: handler}}, "already"},
		{[]Feature{Summary(ModeOff), stubFeature{name: "needs-summary", requires: []string{FeatureSummary}}}, "requires"},
		{[]Feature{stubFeature{name: "weird", configured: Mode(7)}}, "invalid mode"},
		{[]Feature{stubFeature{name: "weird", configured: Mode(-2)}}, "invalid mode"},
	}
	for i, c := range cases {
		if _, err := buildRegistry(c.features); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("case %d: err = %v, want %q", i, err, c.want)
		}
	}
}

func TestClampMode_FailsClosedBelowAndOpensToAutoAbove(t *testing.T) {
	for in, want := range map[Mode]Mode{Mode(-1): ModeOff, ModeOff: ModeOff, ModeSuggest: ModeSuggest, ModeAuto: ModeAuto, Mode(99): ModeAuto} {
		if got := clampMode(in); got != want {
			t.Fatalf("clamp(%d) = %d", in, got)
		}
	}
}

func TestNew_ReportsRegistryErrors(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://nobody@127.0.0.1:1/none")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := New(pool, WithFeatures(stubFeature{name: "x", requires: []string{"y"}})); err == nil {
		t.Fatal("a missing dependency must fail New")
	}
	if _, err := New(pool, WithFeatures(AllFeatures()...)); err != nil {
		t.Fatalf("all features: %v", err)
	}
}

func TestMode_NamesAndPolicy(t *testing.T) {
	for mode, want := range map[Mode]string{ModeOff: "off", ModeManual: "manual", ModeSuggest: "suggest", ModeAuto: "auto", Mode(42): "off"} {
		if mode.String() != want {
			t.Fatalf("%d = %q", mode, mode.String())
		}
	}
	if got := (openPolicy{}).Mode(t.Context(), Scope{Tenant: "t"}, "notes"); got != ModeAuto {
		t.Fatalf("mode = %v", got)
	}
	nopPublisher{}.Publish(t.Context(), Event{})
	for _, f := range AllFeatures() {
		if f.Name() == "" || f.Requires() != nil {
			t.Fatalf("feature %+v", f)
		}
	}
}
