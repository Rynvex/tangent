package tangent

// module is the shape every built-in feature shares; attach registers its
// extension points.
type module struct {
	name       string
	ai         bool
	configured Mode
	requires   []string
	cfg        featureConfig
	attach     func(r *registry, m *module)
}

func (m *module) Name() string       { return m.name }
func (m *module) Requires() []string { return m.requires }
func (m *module) AI() bool           { return m.ai }
func (m *module) mode() Mode         { return m.configured }
func (m *module) register(r *registry) {
	r.configs[m.name] = m.cfg
	if m.attach != nil {
		m.attach(r, m)
	}
}

// configOf is the configuration a feature was enabled with.
func (e *Engine) configOf(feature string) featureConfig { return e.features.configs[feature] }

// onOff is a feature without AI: on.
func onOff(name string, attach func(*registry, *module)) Feature {
	return &module{name: name, configured: ModeAuto, attach: attach}
}

// aiFeature is a feature with AI in the given mode.
func aiFeature(name string, mode Mode, opts []FeatureOption, attach func(*registry, *module)) Feature {
	return &module{name: name, ai: true, configured: mode, cfg: newFeatureConfig(opts), attach: attach}
}
