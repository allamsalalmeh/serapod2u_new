-- Ownership / grants modelled on Supabase defaults; the live values come from the collector.
ALTER FUNCTION public.trigger_document_notification() OWNER TO supabase_admin;
ALTER FUNCTION public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamptz) OWNER TO supabase_admin;
REVOKE EXECUTE ON FUNCTION public.trigger_document_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamptz) TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.documents TO authenticated;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

INSERT INTO organizations (id, org_type_code, org_code, org_name, contact_phone, contact_email) VALUES
 ('00000000-0000-4000-8000-0000000000a1','HQ','HQ1','Serapod HQ','+60100000000','hq@serapod.test'),
 ('00000000-0000-4000-8000-0000000000d1','DIST','DIST-EAR','Eariel Distributor','+60123456001','orders@eariel.test'),
 ('00000000-0000-4000-8000-0000000000f1','MFG','MFG-A','Manufacturer A','+60123456101','a@mfg.test'),
 ('00000000-0000-4000-8000-0000000000f2','MFG','MFG-B','Manufacturer B','+60123456102','b@mfg.test');

INSERT INTO notification_types (category, event_code, event_name, event_description, default_enabled, available_channels, is_system, sort_order) VALUES
 ('order','order_submitted','Order Submitted','old submitted',true,ARRAY['whatsapp','sms','email'],false,1),
 ('order','order_approved','Order Approved','old approved',true,ARRAY['whatsapp','sms','email'],false,2),
 ('order','order_rejected','Order Rejected','old rejected',true,ARRAY['whatsapp','sms','email'],false,3),
 ('order','order_closed','Order Closed','old closed',true,ARRAY['whatsapp','sms','email'],false,4),
 ('order','qr_batch_generated','QR Batch Generated','old qr',false,ARRAY['whatsapp','sms','email'],false,60),
 ('order','manufacturer_scan_complete','Manufacture Completed His Order','old mfg',false,ARRAY['whatsapp','sms','email'],false,65),
 ('order','warehouse_received','Warehouse Receive Order','old wh',false,ARRAY['whatsapp','sms','email'],false,70),
 ('document','po_created','Purchase Order Created','old po created',true,ARRAY['whatsapp','sms','email'],false,1),
 ('document','po_acknowledged','Purchase Order Acknowledged','old po ack',true,ARRAY['whatsapp','sms','email'],false,2),
 ('document','invoice_created','Invoice Created','old inv',true,ARRAY['whatsapp','sms','email'],false,3),
 ('document','invoice_acknowledged','Invoice Acknowledged','old inv ack',true,ARRAY['whatsapp','sms','email'],false,4),
 ('document','payment_received','Payment Received','old pay',true,ARRAY['whatsapp','sms','email'],false,5),
 ('document','receipt_issued','Receipt Issued','old rcpt',true,ARRAY['whatsapp','sms','email'],false,6),
 ('inventory','low_stock_alert','Low Stock Alert','untouched',true,ARRAY['whatsapp'],false,1);

INSERT INTO notification_provider_configs (org_id, channel, provider_name, is_active) VALUES
 ('00000000-0000-4000-8000-0000000000a1','whatsapp','mock_wa',true),
 ('00000000-0000-4000-8000-0000000000a1','sms','mock_sms',true),
 ('00000000-0000-4000-8000-0000000000a1','email','mock_email',true);

-- Settings: one per routing shape the Notification Types page writes.
INSERT INTO notification_settings (org_id, event_code, enabled, channels_enabled, recipient_config) VALUES
 ('00000000-0000-4000-8000-0000000000a1','po_created',true,ARRAY['whatsapp'],'{"routing":{"preset":"whatsapp_sms_email_fallback","source":"category"}}'),
 ('00000000-0000-4000-8000-0000000000a1','po_acknowledged',true,ARRAY['whatsapp','sms'],'{"routing":{"preset":"whatsapp_sms","source":"event"}}'),
 ('00000000-0000-4000-8000-0000000000a1','invoice_created',true,ARRAY['sms'],'{"routing":{"preset":"sms_only","source":"event"}}'),
 ('00000000-0000-4000-8000-0000000000a1','invoice_acknowledged',false,ARRAY[]::text[],'{"routing":{"preset":"whatsapp_only","source":"event"}}'),
 ('00000000-0000-4000-8000-0000000000a1','payment_received',true,ARRAY['email'],'{"routing":{"preset":"email_only","source":"event"}}'),
 ('00000000-0000-4000-8000-0000000000a1','receipt_issued',true,ARRAY['whatsapp'],'{"routing":{"preset":"whatsapp_only","source":"category"}}');

INSERT INTO orders (id, order_no, display_doc_no, order_type, company_id, buyer_org_id, seller_org_id, created_by, status) VALUES
 ('00000000-0000-4000-8000-00000000a001','ORD-H2M-1','PO26000001','H2M','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000f1', gen_random_uuid(),'approved'),
 ('00000000-0000-4000-8000-00000000d001','ORD-D2H-1','SO26000001','D2H','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000a1', gen_random_uuid(),'approved');
