package cli

import (
	"fmt"
	"strings"
)

// baseEnv are the variables of the server's environment every CLI gets:
// where to find programs and the user's files, the locale, and how to reach
// the network (proxy and CA settings).
var baseEnv = []string{
	"PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR",
	"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
}

// sensitiveFragments mark names that may never reach a CLI, whatever the
// allowlist says: the server's own settings (TANGENT_TOKEN, the database
// URL) and API keys (which would also switch a CLI from the subscription to
// per-token API billing).
var sensitiveFragments = []string{"DATABASE_URL", "API_KEY", "SECRET", "PASSWORD"}

func sensitive(name string) bool {
	upper := strings.ToUpper(name)
	if strings.HasPrefix(upper, "TANGENT_") {
		return true
	}
	for _, fragment := range sensitiveFragments {
		if strings.Contains(upper, fragment) {
			return true
		}
	}
	return false
}

// checkExtraEnv refuses extra names a CLI may not see.
func checkExtraEnv(names []string) error {
	for _, name := range names {
		name = strings.TrimSpace(name)
		switch {
		case name == "" || strings.ContainsAny(name, "= \t"):
			return fmt.Errorf("cli: %q is not an environment variable name", name)
		case sensitive(name):
			return fmt.Errorf("cli: %s may not be passed to the CLI", name)
		}
	}
	return nil
}

// buildEnv is the process environment: the allowlisted variables of
// environ (base, the backend's own, the configured extras; LC_* always),
// minus anything sensitive.
func buildEnv(environ, backendNames, extraNames []string) []string {
	allowed := map[string]bool{}
	for _, list := range [][]string{baseEnv, backendNames, extraNames} {
		for _, name := range list {
			allowed[strings.TrimSpace(name)] = true
		}
	}
	out := make([]string, 0, len(allowed))
	for _, entry := range environ {
		name, _, ok := strings.Cut(entry, "=")
		if !ok || sensitive(name) || (!allowed[name] && !strings.HasPrefix(name, "LC_")) {
			continue
		}
		out = append(out, entry)
	}
	return out
}
