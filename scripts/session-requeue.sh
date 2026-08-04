#!/usr/bin/env bash
# session-requeue.sh — patch a stuck session back to a target state and requeue its job
#
# Usage:
#   pnpm session:requeue <sessionId> <queue>
#   ./scripts/session-requeue.sh <sessionId> <queue>
#
# Examples:
#   pnpm session:requeue e4c1826a-... session.generate
#   pnpm session:requeue e4c1826a-... session.workflow
#
# Valid queues: session.generate | session.workflow | session.revise | documents.process
#
# The script:
#   1. Maps the queue name to its XState state
#   2. Patches the session status + xstate_snapshot value in the DB
#   3. Inserts a fresh pending queue message
#   4. Prints a reminder to restart the API server

set -euo pipefail

DB_URL="postgres://shipwright:shipwright@localhost:5433/shipwright"

SESSION_ID="${1:-}"
QUEUE="${2:-}"

if [[ -z "$SESSION_ID" || -z "$QUEUE" ]]; then
  echo "Usage: $0 <sessionId> <queue>"
  echo "  queue: session.generate | session.workflow | session.revise | documents.process"
  exit 1
fi

# Map queue → XState state + DB status
case "$QUEUE" in
  session.generate)
    XSTATE="generating"
    STATUS="generating"
    ;;
  session.workflow)
    XSTATE="summarizing"
    STATUS="summarizing"
    ;;
  session.revise)
    XSTATE="revising"
    STATUS="revising"
    ;;
  documents.process)
    XSTATE="uploading"
    STATUS="uploading"
    ;;
  *)
    echo "Unknown queue: $QUEUE"
    echo "Valid: session.generate | session.workflow | session.revise | documents.process"
    exit 1
    ;;
esac

echo "==> Patching session $SESSION_ID → $STATUS / xstate: $XSTATE"
psql "$DB_URL" -c "
UPDATE agent_sessions
SET status = '$STATUS',
    xstate_snapshot = jsonb_set(
      COALESCE(xstate_snapshot, '{}'::jsonb),
      '{value}',
      '\"$XSTATE\"'
    )
WHERE id = '$SESSION_ID';" 2>&1

echo "==> Inserting pending queue message on $QUEUE"
MSG_ID=$(psql "$DB_URL" -t -c "
INSERT INTO queue_messages (queue, payload, status, attempts, max_attempts)
VALUES ('$QUEUE', '{\"sessionId\": \"$SESSION_ID\"}'::jsonb, 'pending', 0, 3)
RETURNING id;" 2>&1 | tr -d ' ')

echo "    message id: $MSG_ID"
echo ""
echo "==> Restart the API server to pick up the queued message."
echo "    (startup recovery scans pending rows on boot)"
