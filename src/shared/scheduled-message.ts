import type { Message } from '@ag-ui/core';

// A durable marker for scheduled-task prompts in the canonical transcript. The
// message ID identifies a scheduled turn on its own.
export const scheduledTaskMessagePrefix = 'opendots:scheduled_task:';

export function isScheduledTaskMessage(
  message: Pick<Message, 'id' | 'role' | 'metadata'>,
): boolean {
  if (message.role !== 'user') return false;
  if (message.id.startsWith(scheduledTaskMessagePrefix)) return true;
  const metadata = message.metadata;
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    'opendotsSource' in metadata &&
    metadata.opendotsSource === 'scheduled_task'
  );
}
