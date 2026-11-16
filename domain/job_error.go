package domain

// Fixed failure texts of a feature's background job (never the model's
// output), and the code a client sees for each in job.failed.
const (
	JobRunFailedText = "the job run failed"
	JobUnusableText  = "the job run did not return a usable answer"
)

// Codes of a failed job (JobError.Code); the leaf draft uses the same.
const (
	JobErrorRunFailed = "run_failed"
	JobErrorUnusable  = "unusable"
	JobErrorTimedOut  = "timed_out"
	JobErrorFailed    = "failed"
)

// JobError says why a background job failed.
type JobError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// JobErrorFor names the failure a job ended with (its stored error text).
func JobErrorFor(text string) JobError {
	code := JobErrorFailed
	switch text {
	case JobRunFailedText, LeafDraftRunFailedText:
		code = JobErrorRunFailed
	case JobUnusableText, LeafDraftUnusableText:
		code = JobErrorUnusable
	case JobTimedOutText:
		code = JobErrorTimedOut
	}
	return JobError{Code: code, Message: text}
}
