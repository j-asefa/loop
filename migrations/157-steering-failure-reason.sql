ALTER TABLE run_steering ADD COLUMN failure_reason TEXT
  CHECK(failure_reason IN ('run-ended-unread','delivery-unconfirmed'));

DROP TRIGGER run_steering_stopped;
CREATE TRIGGER run_steering_stopped AFTER UPDATE OF state ON runs
WHEN NEW.state IN ('completed','failed','cancelled','interrupted')
BEGIN
  UPDATE run_steering SET state='failed',
    failure_reason=CASE state WHEN 'sending' THEN 'delivery-unconfirmed' ELSE 'run-ended-unread' END,
    error=CASE state
      WHEN 'sending' THEN 'Delivery could not be confirmed before the run stopped. Review its messages before sending again.'
      ELSE 'The run ended before this message could be delivered. Send it again to continue.' END
    WHERE run_id=NEW.id AND state IN ('pending','sending');
END;
