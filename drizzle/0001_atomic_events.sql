CREATE TRIGGER events_apply AFTER INSERT ON events BEGIN
 UPDATE sessions SET event_count=NEW.sequence,payload_bytes=payload_bytes+NEW.payload_bytes,
 revision=revision+CASE WHEN NEW.type='document' THEN 1 ELSE 0 END,
 document=CASE WHEN NEW.type='document' THEN NEW.document ELSE document END,
 updated_at=NEW.created_at WHERE id=NEW.session_id;
 INSERT INTO document_revisions(session_id,revision,event_id,markdown,created_at)
 SELECT NEW.session_id,revision,NEW.id,NEW.document,NEW.created_at FROM sessions WHERE id=NEW.session_id AND NEW.type='document';
END;
