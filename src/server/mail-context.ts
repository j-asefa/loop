// Use with the messages alias `m` at model-context and attachment boundaries.
// Owner-visible history retains refused/cancelled mail, but it cannot become
// a later model input or grant file access through that retained message.
// A terminal failure can occur before provider dispatch. Only active or
// completed deliveries authorize these passive reads; uncertainty does not.
export const READABLE_MAIL_SQL = `(json_extract(m.metadata,'$.automation.mailId') IS NULL OR EXISTS(
  SELECT 1 FROM agent_mail mail JOIN runs delivery ON delivery.id=m.run_id AND delivery.owner_id=m.owner_id
  WHERE mail.id=json_extract(m.metadata,'$.automation.mailId') AND mail.owner_id=m.owner_id
    AND mail.state='sent' AND delivery.state IN ('running','pausing','awaiting_approval','completed')
    AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.message_id=m.id AND s.state<>'delivered')
))`;
