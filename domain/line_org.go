package domain

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Organising main lines (B18): a folder groups conversations in the list and
// tags label their topics. Both belong to main lines only; a branch always
// has folder "" and no tags.

// Limits of folders and tags.
const (
	// FolderMaxRunes caps a folder name.
	FolderMaxRunes = 40
	// TagsMax caps the tags of one main line.
	TagsMax = 12
	// TagMaxRunes caps one tag.
	TagMaxRunes = 24
	// FolderUnfiled is the GET /lines filter value for main lines without a
	// folder; it cannot be a folder's name.
	FolderUnfiled = "__unfiled__"
)

// OrganizeBranchError refuses a folder or tags given for a branch
// (invalid_input naming the field).
func OrganizeBranchError(field string) error {
	return NewError(CodeInvalidInput, "folders and tags belong to main conversations, not branches", map[string]any{"field": field})
}

// NormalizeFolder trims a folder name and removes its control characters;
// "" means unfiled. Longer than FolderMaxRunes, or the reserved
// FolderUnfiled, is invalid_input (field folder).
func NormalizeFolder(folder string) (string, error) {
	folder = strings.TrimSpace(dropControls(folder))
	switch {
	case utf8.RuneCountInString(folder) > FolderMaxRunes:
		return "", folderError(fmt.Sprintf("a folder name is at most %d characters", FolderMaxRunes))
	case folder == FolderUnfiled:
		return "", folderError(FolderUnfiled + " is reserved")
	}
	return folder, nil
}

// NormalizeTag is one tag as stored: control characters removed, trimmed,
// leading "#" removed, lower case. "" when nothing is left.
func NormalizeTag(tag string) string {
	tag = strings.TrimSpace(dropControls(tag))
	tag = strings.TrimSpace(strings.TrimLeft(tag, "#"))
	return strings.ToLower(tag)
}

// NormalizeTags normalises every tag (NormalizeTag), drops the empty ones
// and the repeats (first one kept, input order) and refuses a tag over
// TagMaxRunes or more than TagsMax tags with invalid_input (field tags).
// The result is never nil.
func NormalizeTags(tags []string) ([]string, error) {
	out := make([]string, 0, len(tags))
	seen := make(map[string]bool, len(tags))
	for _, raw := range tags {
		tag := NormalizeTag(raw)
		if tag == "" || seen[tag] {
			continue
		}
		if utf8.RuneCountInString(tag) > TagMaxRunes {
			return nil, tagsError(fmt.Sprintf("a tag is at most %d characters", TagMaxRunes))
		}
		seen[tag] = true
		out = append(out, tag)
	}
	if len(out) > TagsMax {
		return nil, tagsError(fmt.Sprintf("a conversation has at most %d tags", TagsMax))
	}
	return out, nil
}

// LineOrganization is a main line's folder and tags, normalised.
type LineOrganization struct {
	Folder string
	Tags   []string
}

// NormalizeOrganization normalises an optional folder and optional tags
// (nil leaves each as given: "" and no tags).
func NormalizeOrganization(folder *string, tags *[]string) (LineOrganization, error) {
	out := LineOrganization{Tags: []string{}}
	var err error
	if folder != nil {
		if out.Folder, err = NormalizeFolder(*folder); err != nil {
			return LineOrganization{}, err
		}
	}
	if tags != nil {
		if out.Tags, err = NormalizeTags(*tags); err != nil {
			return LineOrganization{}, err
		}
	}
	return out, nil
}

func folderError(message string) error {
	return NewError(CodeInvalidInput, message, map[string]any{"field": "folder"})
}

func tagsError(message string) error {
	return NewError(CodeInvalidInput, message, map[string]any{"field": "tags"})
}

// dropControls removes every control character (line breaks and tabs
// included) and the bidirectional controls.
func dropControls(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || isBidiControl(r) {
			return -1
		}
		return r
	}, text)
}

// TenantOrganization is the tenant's folders and tags over all its main lines
// (B18.1: GET /lines/organization), so a list that shows one page or one
// filter still names every folder and tag with its real counts.
type TenantOrganization struct {
	// Folders are the non-empty folders by name (code point order), with
	// the main lines in each: active and archived counted apart.
	Folders []FolderSummary `json:"folders"`
	// Tags are the tags of unarchived main lines, most used first, then by
	// name.
	Tags []TagSummary `json:"tags"`
}

// FolderSummary is one folder of TenantOrganization.
type FolderSummary struct {
	Folder   string `json:"folder"`
	Active   int    `json:"active"`
	Archived int    `json:"archived"`
}

// TagSummary is one tag of TenantOrganization: Count unarchived main lines
// carry it.
type TagSummary struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}
