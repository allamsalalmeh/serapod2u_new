#!/bin/bash
# Disposable-database tests for the two notification migrations. No network, no providers.
set -u
P="psql -h /tmp -p 55432 -U postgres -X -q -v ON_ERROR_STOP=1"
HERE="$(cd "$(dirname "$0")" && pwd)"; A="$HERE/../../migrations/20261027160000_notification_types_order_copy.sql"
B="$HERE/../../migrations/20261030100000_supply_chain_document_notifications.sql"
pass=0; fail=0
check() { # name, db, sql returning t/f
  local r; r=$($P -d "$2" -tAc "$3" 2>&1)
  if [ "$r" = "t" ]; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); echo "FAIL  $1  -> $r"; fi
}
fresh() { dropdb -h /tmp -p 55432 -U postgres --if-exists "$1"; createdb -h /tmp -p 55432 -U postgres -T pre "$1"; }
apply() { # db file role
  $P -d "$1" -c "SET ROLE ${3:-supabase_admin}" -f "$2" 2>&1
}
HQ=00000000-0000-4000-8000-0000000000a1; MA=00000000-0000-4000-8000-0000000000f1; EAR=00000000-0000-4000-8000-0000000000d1
OH=00000000-0000-4000-8000-00000000a001; OD=00000000-0000-4000-8000-00000000d001
doc() { # db id order type status no issued_by issued_to
  $P -d "$1" -c "INSERT INTO documents (id, order_id, doc_type, doc_no, status, issued_by_org_id, issued_to_org_id, company_id, created_by) VALUES ('$2','$3','$4','$6','$5','$7','$8','$HQ',gen_random_uuid())" 2>&1
}
rows() { echo "(SELECT count(*) FROM notifications_outbox WHERE event_code='$1' ${2:-})"; }

echo "== 0. Pre-state (current staging trigger) =="
fresh t0
doc t0 00000000-0000-4000-8000-0000000000b1 $OH PO pending PO-ORD-H2M-1 $HQ $MA >/dev/null
check "old: po_created queued once (first hop whatsapp)" t0 "SELECT $(rows po_created) = 1"
check "old: payload has no document_id" t0 "SELECT NOT (payload_json ? 'document_id') FROM notifications_outbox WHERE event_code='po_created'"
$P -d t0 -c "UPDATE documents SET status='acknowledged' WHERE id='00000000-0000-4000-8000-0000000000b1'" >/dev/null
check "old: po_acknowledged never queued (INSERT-only trigger)" t0 "SELECT $(rows po_acknowledged) = 0"
doc t0 00000000-0000-4000-8000-0000000000b2 $OD INVOICE pending INV-ORD-D2H-1 $HQ $EAR >/dev/null
check "old: invoice_created with SMS-only setting queues nothing (SMS not offered)" t0 "SELECT $(rows invoice_created) = 0"
# Queue failure under the old trigger: the business INSERT is rolled back.
$P -d t0 -c "CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected outbox failure''; END'; CREATE TRIGGER boom BEFORE INSERT ON notifications_outbox FOR EACH ROW EXECUTE FUNCTION boom();" >/dev/null
out=$(doc t0 00000000-0000-4000-8000-0000000000b3 $OH PO pending PO-FAIL $HQ $MA)
echo "      old trigger + outbox failure -> $(echo "$out" | grep -o 'ERROR:.*' | head -1)"
check "old: outbox failure rolls back the document insert" t0 "SELECT NOT EXISTS (SELECT 1 FROM documents WHERE id='00000000-0000-4000-8000-0000000000b3')"

echo "== 1. Upgrade, ownership, rollback on injected failure =="
fresh t1
before_acl=$($P -d t1 -tAc "SELECT pg_get_userbyid(proowner)||'|'||coalesce(proacl::text,'') FROM pg_proc WHERE proname='trigger_document_notification'")
out=$(apply t1 $B app_owner); echo "$out" | grep -E "ERROR" | head -1 | sed 's/^/      as non-owner: /'
check "non-owner run fails and changes nothing" t1 "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='trigger_document_ack_notification')=0 AND (SELECT prosrc NOT LIKE '%document_id%' FROM pg_proc WHERE proname='trigger_document_notification')"
# Injected post-check failure: an extra trigger already calls the function.
$P -d t1 -c "CREATE TRIGGER legacy_dup AFTER UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION trigger_document_notification()" >/dev/null
out=$(apply t1 $B); echo "$out" | grep -E "ERROR" | head -1 | sed 's/^/      injected failure: /'
check "failed post-check rolls everything back (old body kept, no ack trigger)" t1 "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='trigger_document_ack_notification')=0 AND (SELECT prosrc NOT LIKE '%document_id%' FROM pg_proc WHERE proname='trigger_document_notification')"
$P -d t1 -c "DROP TRIGGER legacy_dup ON documents" >/dev/null
fp_before=$($P -d t1 -tAc "SELECT md5(string_agg(to_jsonb(s)::text,'|' ORDER BY id)) FROM notification_settings s")||true
trg_before=$($P -d t1 -tAc "SELECT string_agg(pg_get_triggerdef(oid)||tgenabled::text, E'\n' ORDER BY tgname) FROM pg_trigger WHERE tgrelid='documents'::regclass AND NOT tgisinternal")
out=$(apply t1 $B); echo "$out" | grep -E "NOTICE|ERROR" | sed 's/^/      /'
check "upgrade applied: ack trigger present, 2 triggers call the function" t1 "SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid='documents'::regclass AND tgfoid='trigger_document_notification()'::regprocedure)=2"
check "owner and ACL of trigger function preserved" t1 "SELECT pg_get_userbyid(proowner)||'|'||coalesce(proacl::text,'') = '$before_acl' FROM pg_proc WHERE proname='trigger_document_notification'"
check "unrelated documents triggers unchanged" t1 "SELECT string_agg(pg_get_triggerdef(oid)||tgenabled::text, E'\n' ORDER BY tgname) = \$q\$$trg_before\$q\$ FROM pg_trigger WHERE tgrelid='documents'::regclass AND NOT tgisinternal AND tgname<>'trigger_document_ack_notification'"
check "notification_settings unchanged" t1 "SELECT md5(string_agg(to_jsonb(s)::text,'|' ORDER BY id)) = '$fp_before' FROM notification_settings s"
out=$(apply t1 $B); echo "$out" | grep -E "NOTICE|ERROR" | sed 's/^/      rerun: /'
check "rerun is safe (still exactly 2 triggers)" t1 "SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid='documents'::regclass AND tgfoid='trigger_document_notification()'::regprocedure)=2"

echo "== 2. Lifecycle events after upgrade (t1) =="
PO=00000000-0000-4000-8000-0000000000c1
doc t1 $PO $OH PO pending PO-ORD-H2M-1 $HQ $MA >/dev/null
check "H2M po_created: fallback preset queues first hop only (whatsapp)" t1 "SELECT array_agg(channel ORDER BY channel)='{whatsapp}' FROM notifications_outbox WHERE event_code='po_created'"
check "payload keeps old keys and adds ids" t1 "SELECT payload_json ?& ARRAY['doc_type','doc_no','order_no','issued_by','issued_to','document_id','order_id','order_type','issued_by_org_id','issued_to_org_id','display_order_no'] AND payload_json->>'document_id'='$PO' AND payload_json->>'order_id'='$OH' AND payload_json->>'order_type'='H2M' AND payload_json->>'order_no'='ORD-H2M-1' AND payload_json->>'display_order_no'='PO26000001' FROM notifications_outbox WHERE event_code='po_created'"
$P -d t1 -c "UPDATE documents SET status='acknowledged' WHERE id='$PO'" >/dev/null
check "PO pending->acknowledged: po_acknowledged on WhatsApp AND SMS (independent channels)" t1 "SELECT array_agg(channel ORDER BY channel)='{sms,whatsapp}' FROM notifications_outbox WHERE event_code='po_acknowledged'"
$P -d t1 -c "UPDATE documents SET status='acknowledged', updated_at=now() WHERE id='$PO'" >/dev/null
$P -d t1 -c "UPDATE documents SET doc_no=doc_no WHERE id='$PO'" >/dev/null
check "no-op updates queue nothing more" t1 "SELECT $(rows po_acknowledged) = 2"
$P -d t1 -c "UPDATE documents SET status='pending' WHERE id='$PO'; UPDATE documents SET status='acknowledged' WHERE id='$PO'" >/dev/null
check "re-acknowledgement of the same document queues nothing more (once per document)" t1 "SELECT $(rows po_acknowledged) = 2"
$P -d t1 -c "UPDATE documents SET status='completed' WHERE id='$PO'" >/dev/null
check "acknowledged->completed queues nothing" t1 "SELECT count(*)=3 FROM notifications_outbox"
INV=00000000-0000-4000-8000-0000000000c2
doc t1 $INV $OD INVOICE pending INV-ORD-D2H-1 $HQ $EAR >/dev/null
check "D2H invoice_created with SMS-only setting now queues SMS once" t1 "SELECT array_agg(channel)='{sms}' FROM notifications_outbox WHERE event_code='invoice_created'"
$P -d t1 -c "UPDATE documents SET status='acknowledged' WHERE id='$INV'" >/dev/null
check "disabled event (invoice_acknowledged) queues nothing" t1 "SELECT $(rows invoice_acknowledged) = 0"
PAY1=00000000-0000-4000-8000-0000000000c3; PAY2=00000000-0000-4000-8000-0000000000c4
doc t1 $PAY1 $OD PAYMENT pending PAY-ORD-D2H-1 $EAR $HQ >/dev/null
doc t1 $PAY2 $OD PAYMENT pending PAY-ORD-D2H-1-BAL $EAR $HQ >/dev/null
check "pending PAYMENT insert queues nothing" t1 "SELECT $(rows payment_received) = 0"
$P -d t1 -c "UPDATE documents SET status='acknowledged' WHERE id IN ('$PAY1','$PAY2')" >/dev/null
check "deposit and balance payments each queue payment_received once (email only)" t1 "SELECT count(*)=2 AND bool_and(channel='email') AND count(DISTINCT payload_json->>'doc_no')=2 FROM notifications_outbox WHERE event_code='payment_received'"
doc t1 00000000-0000-4000-8000-0000000000c5 $OD RECEIPT completed RCPT-ORD-D2H-1 $HQ $EAR >/dev/null
check "receipt_issued queued once on whatsapp" t1 "SELECT array_agg(channel)='{whatsapp}' FROM notifications_outbox WHERE event_code='receipt_issued'"
doc t1 00000000-0000-4000-8000-0000000000c6 $OH PO acknowledged PO-DIRECT $HQ $MA >/dev/null
$P -d t1 -c "UPDATE documents SET status='completed' WHERE id='00000000-0000-4000-8000-0000000000c6'" >/dev/null
check "document inserted already acknowledged: one event from INSERT, none from UPDATE" t1 "SELECT count(*)=2 FROM notifications_outbox WHERE event_code='po_acknowledged' AND payload_json->>'document_id'='00000000-0000-4000-8000-0000000000c6'"
doc t1 00000000-0000-4000-8000-0000000000c7 $OD SO pending SO-ORD-D2H-1 $HQ $EAR >/dev/null
$P -d t1 -c "UPDATE documents SET status='acknowledged' WHERE id='00000000-0000-4000-8000-0000000000c7'" >/dev/null
check "SO/DO documents and their acknowledgement queue nothing" t1 "SELECT NOT EXISTS (SELECT 1 FROM notifications_outbox WHERE payload_json->>'doc_type' IN ('SO','DO'))"
$P -d t1 -c "UPDATE notification_provider_configs SET is_active=false WHERE channel='sms'" >/dev/null
doc t1 00000000-0000-4000-8000-0000000000c8 $OD INVOICE pending INV-2 $HQ $EAR 2>&1 | grep -o "WARNING:.*" | head -1 | sed 's/^/      /'
check "no active provider: nothing queued, document kept (existing queue_notification rule)" t1 "SELECT $(rows invoice_created "AND payload_json->>'doc_no'='INV-2'") = 0 AND EXISTS (SELECT 1 FROM documents WHERE doc_no='INV-2')"
$P -d t1 -c "UPDATE notification_provider_configs SET is_active=true WHERE channel='sms'" >/dev/null

echo "== 3. Queue failure policy (t1) =="
$P -d t1 -c "CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected outbox failure''; END'; CREATE TRIGGER boom BEFORE INSERT ON notifications_outbox FOR EACH ROW EXECUTE FUNCTION boom();" >/dev/null
PO2=00000000-0000-4000-8000-0000000000c9
doc t1 $PO2 $OH PO pending PO-2 $HQ $MA 2>&1 | grep -o "WARNING:.*" | head -1 | sed 's/^/      insert: /'
$P -d t1 -c "UPDATE documents SET status='acknowledged' WHERE id='$PO2'" 2>&1 | grep -o "WARNING:.*" | head -1 | sed 's/^/      ack: /'
check "outbox failure: document insert and acknowledgement are kept, nothing queued, WARNING raised" t1 "SELECT status='acknowledged' FROM documents WHERE id='$PO2'"
check "outbox failure: no partial channel rows" t1 "SELECT NOT EXISTS (SELECT 1 FROM notifications_outbox WHERE payload_json->>'document_id'='$PO2')"
$P -d t1 -c "DROP TRIGGER boom ON notifications_outbox" >/dev/null

echo "== 4. Wording migration =="
fresh t4
fp_s=$($P -d t4 -tAc "SELECT md5(string_agg(to_jsonb(s)::text,'|' ORDER BY id)) FROM notification_settings s")
out=$(apply t4 $A); echo "$out" | grep -E "rows updated|not installed|ERROR" | sed 's/^/      before B: /'
echo "$out" | grep -c "original " | sed 's/^/      originals printed: /'
check "before B: 10 rows changed, 3 acknowledgement rows untouched" t4 "SELECT (SELECT count(*) FROM notification_types WHERE event_description LIKE 'When:%')=10 AND (SELECT count(*) FROM notification_types WHERE event_code IN ('po_acknowledged','invoice_acknowledged','payment_received') AND event_description LIKE 'old%')=3"
check "names: 2 changed, others kept" t4 "SELECT (SELECT event_name FROM notification_types WHERE event_code='manufacturer_scan_complete')='Manufacture Completed' AND (SELECT event_name FROM notification_types WHERE event_code='order_submitted')='Order Submitted'"
check "category/default_enabled/channels unchanged; unrelated row untouched" t4 "SELECT (SELECT count(*) FROM notification_types WHERE category='order')=7 AND (SELECT event_description FROM notification_types WHERE event_code='low_stock_alert')='untouched' AND (SELECT default_enabled FROM notification_types WHERE event_code='qr_batch_generated')=false"
check "notification_settings unchanged" t4 "SELECT md5(string_agg(to_jsonb(s)::text,'|' ORDER BY id))='$fp_s' FROM notification_settings s"
apply t4 $B >/dev/null
ts=$($P -d t4 -tAc "SELECT max(updated_at) FROM notification_types WHERE event_code='order_submitted'")
out=$(apply t4 $A); echo "$out" | grep -E "rows updated|ERROR" | sed 's/^/      after B: /'
check "after B: acknowledgement rows completed" t4 "SELECT count(*)=13 FROM notification_types WHERE event_description LIKE 'When:%'"
check "already-correct rows not touched again (updated_at kept)" t4 "SELECT updated_at='$ts' FROM notification_types WHERE event_code='order_submitted'"
out=$(apply t4 $A); echo "$out" | grep -E "rows updated" | sed 's/^/      rerun: /'
check "no staging/build commentary in catalog text" t4 "SELECT NOT EXISTS (SELECT 1 FROM notification_types WHERE event_description ILIKE '%staging%' OR event_description ILIKE '%build%')"
fresh t5
$P -d t5 -c "DELETE FROM notification_settings WHERE event_code='receipt_issued'; DELETE FROM notification_types WHERE event_code='receipt_issued'" >/dev/null
out=$(apply t5 $A); echo "$out" | grep -E "ERROR" | head -1 | sed 's/^/      missing event: /'
check "missing expected event: fails, nothing changed" t5 "SELECT NOT EXISTS (SELECT 1 FROM notification_types WHERE event_description LIKE 'When:%')"
fresh t6
$P -d t6 -c "CREATE FUNCTION audit_nt() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER audit_nt AFTER UPDATE ON notification_types FOR EACH ROW EXECUTE FUNCTION audit_nt()" >/dev/null
out=$(apply t6 $A); echo "$out" | grep -E "ERROR" | head -1 | sed 's/^/      unknown trigger: /'
check "unexpected catalog UPDATE trigger: fails, nothing changed" t6 "SELECT NOT EXISTS (SELECT 1 FROM notification_types WHERE event_description LIKE 'When:%')"

echo; echo "RESULT: $pass passed, $fail failed"
