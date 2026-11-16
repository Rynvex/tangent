// Command tangent-server is tangent's reference server: the HTTP API under
// /api, the /events stream, a model runner (fake, openai-compatible or
// anthropic), the maintenance loop and, optionally, the demo UI. It is
// configured only through environment variables (see .env.example).
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel(os.Getenv("TANGENT_LOG_LEVEL"))}))
	if err := run(ctx, os.Getenv, log); err != nil {
		fmt.Fprintln(os.Stderr, "tangent-server:", explainStartupError(err))
		stop()
		os.Exit(1)
	}
}

// logLevel reads TANGENT_LOG_LEVEL (debug, info, warn, error; default info).
func logLevel(text string) slog.Level {
	var level slog.Level
	if err := level.UnmarshalText([]byte(text)); err != nil {
		return slog.LevelInfo
	}
	return level
}
