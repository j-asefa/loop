-- Retired catalog feeds are no longer offered for subscription.
DELETE FROM feed_subscriptions WHERE feed_id IN ('reddit-localllama','reddit-machinelearning','reddit-programming','reddit-science','reddit-technology','reddit-worldnews');
INSERT INTO schema_version VALUES(66,unixepoch()*1000);
