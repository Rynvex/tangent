/**
 * The move cap on its own (F20a): the branch errors' wording in the main bundle
 * reads it, the move planner (`branch-move.ts`, which re-exports it) loads with
 * its dialog.
 */

/** Default cap on messages moved at once (domain.DefaultLimits().Branch.MoveMaxMessages). */
export const BRANCH_MOVE_MAX = 40;
