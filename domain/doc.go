// Package domain holds the pure types and logic of tangent's tree-structured
// conversations: lines and messages, branches and their background packs,
// conclusion cards, notes, chapters, rolling summaries and the turn prompt.
//
// Nothing here does IO. The package imports only the standard library and
// github.com/google/uuid, so the store, the engine and any host can share it.
// See docs/devlog/S1-domain.md for the package design notes.
package domain
