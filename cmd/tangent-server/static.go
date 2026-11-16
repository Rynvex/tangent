package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// staticHeaders are set on every file of the demo UI.
var staticHeaders = map[string]string{
	"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
		"font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options":        "DENY",
	"Referrer-Policy":        "no-referrer",
}

// spa serves a built single-page app from root: GET and HEAD only, no dot
// segments, nothing outside root (symlinks included); a path that is not a
// file gets index.html.
type spa struct {
	root string // symlinks resolved
}

func newSPA(dir string) (spa, error) {
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return spa{}, err
	}
	root, err = filepath.Abs(root)
	return spa{root: root}, err
}

func (s spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for name, value := range staticHeaders {
		w.Header().Set(name, value)
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if hasDotSegment(r.URL.Path) || hasDotSegment(r.URL.RawPath) {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	file, ok := s.resolve(r.URL.Path)
	if !ok {
		file, ok = s.resolve("/index.html")
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	s.serveFile(w, r, file)
}

// resolve maps a URL path to a regular file inside root.
func (s spa) resolve(urlPath string) (string, bool) {
	clean := path.Clean("/" + urlPath)
	if clean == "/" {
		clean = "/index.html"
	}
	real, err := filepath.EvalSymlinks(filepath.Join(s.root, filepath.FromSlash(clean)))
	if err != nil || !strings.HasPrefix(real, s.root+string(filepath.Separator)) {
		return "", false
	}
	info, err := os.Stat(real)
	return real, err == nil && info.Mode().IsRegular()
}

func (s spa) serveFile(w http.ResponseWriter, r *http.Request, file string) {
	f, err := os.Open(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// hasDotSegment reports a "." or ".." path segment.
func hasDotSegment(p string) bool {
	for _, segment := range strings.Split(p, "/") {
		if segment == "." || segment == ".." {
			return true
		}
	}
	return false
}
