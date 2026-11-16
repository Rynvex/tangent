package store

// SetFeatureExtension makes a feature need another extension until the
// returned function restores it (tests of a server without the extension).
func SetFeatureExtension(feature, extension string) (restore func()) {
	old, had := featureExtensions[feature]
	featureExtensions[feature] = extension
	return func() {
		if had {
			featureExtensions[feature] = old
			return
		}
		delete(featureExtensions, feature)
	}
}

// SearchSQLFor is the message statement a query runs (for EXPLAIN in tests).
func SearchSQLFor(query string, older bool) string { return searchSQLFor(query, older) }

// SetSearchWindow changes how many newest messages a search walks first,
// until the returned function restores it.
func SetSearchWindow(n int) (restore func()) {
	old := searchWindow
	searchWindow = n
	return func() { searchWindow = old }
}
