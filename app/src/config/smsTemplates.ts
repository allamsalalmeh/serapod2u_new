/**
 * Dedicated SMS templates for system events.
 *
 * WhatsApp and email copy stay in notificationTemplates.ts.
 * Edit this file when you want to change the SMS a recipient actually receives.
 *
 * Placeholders use {{name}} and are filled by the outbox worker / OTP router.
 */
export type SmsTemplate = {
    id: string
    name: string
    description?: string
    channel: 'sms'
    body: string
}

export const smsTemplates: Record<string, SmsTemplate[]> = {
    order_submitted: [{
        id: 'os_sms_1',
        name: 'SMS Approval Alert',
        description: 'Short SMS when a new order needs approval',
        channel: 'sms',
        body: `[Serapod]  Order #{{order_no}} submitted by {{User}} for RM {{amount}} needs approval.`,
    }],
    order_approved: [{
        id: 'oa_sms_1',
        name: 'SMS Approval Notice',
        channel: 'sms',
        body: `[Serapod2U] Order #{{order_no}} APPROVED by {{approved_by}}. Amount: RM {{amount}}.}`,
    }],
    order_closed: [{
        id: 'oc_sms_1',
        name: 'SMS Closed Notice',
        channel: 'sms',
        body: `[Serapod2U] Order #{{order_no}} is now CLOSED. Total: RM {{amount}}. All documents processed.`,
    }],
    order_rejected: [{
        id: 'orj_sms_1',
        name: 'SMS Rejection Notice',
        channel: 'sms',
        body: `[Serapod2U] Order #{{order_no}} has been {{status}}. Reason: {{reason}}. Amount: RM {{amount}}.`,
    }],
    order_deleted: [{
        id: 'od_sms_1',
        name: 'SMS Deleted Notice',
        channel: 'sms',
        body: `[Serapod2U] Order #{{order_no}} DELETED by {{deleted_by}} at {{deleted_at}}. All records permanently removed.`,
    }],
    manufacturer_scan_complete: [{
        id: 'msc_sms_1',
        name: 'SMS Manufacture Complete',
        channel: 'sms',
        body: `[Serapod2U] Manufacturing complete: Order #{{order_no}} — {{total_master_codes}} cases, {{total_unique_codes}} QR codes. Ready to ship.`,
    }],
    qr_batch_generated: [{
        id: 'qbg_sms_1',
        name: 'SMS QR Batch Ready',
        channel: 'sms',
        body: `[Serapod2U] QR batch generated: Order #{{order_no}} — {{total_master_codes}} cases, {{total_unique_codes}} QR codes. Ready for manufacturing.`,
    }],
    warehouse_received: [{
        id: 'wr_sms_1',
        name: 'SMS Warehouse Received',
        channel: 'sms',
        body: `[Serapod2U] Warehouse received: Order #{{order_no}} — {{total_received}} codes. Inventory updated at {{warehouse_name}}.`,
    }],
    low_stock_alert: [{
        id: 'lsa_sms_1',
        name: 'SMS Low Stock',
        channel: 'sms',
        body: `[Serapod2U] LOW STOCK: {{product_name}} ({{variant_name}}) — {{available_qty}} units left. Reorder point: {{reorder_point}}. Restock recommended.`,
    }],
    out_of_stock: [{
        id: 'oos_sms_1',
        name: 'SMS Out of Stock',
        channel: 'sms',
        body: `[Serapod2U] URGENT: {{product_name}} ({{variant_name}}) is OUT OF STOCK at {{warehouse_name}}. Immediate restock needed.`,
    }],
    stock_received: [{
        id: 'sr_sms_1',
        name: 'SMS Stock Received',
        channel: 'sms',
        body: `[Serapod2U] Stock received: {{product_name}} — {{quantity_received}} units. Total now: {{total_on_hand}} units.`,
    }],
    qr_activated: [{
        id: 'qa_sms_1',
        name: 'SMS QR Activated',
        channel: 'sms',
        body: `[Serapod2U] QR scan: {{product_name}} — Code {{qr_code}} activated at {{scanned_at}}.`,
    }],
    points_awarded: [{
        id: 'pa_sms_1',
        name: 'SMS Points Awarded',
        channel: 'sms',
        body: `[Serapod2U] {{consumer_name}} earned {{points_earned}} points for {{product_name}}. Total: {{total_points}} pts.`,
    }],
    lucky_draw_entry: [{
        id: 'lde_sms_1',
        name: 'SMS Lucky Draw',
        channel: 'sms',
        body: `[Serapod2U] Lucky draw entry by {{consumer_name}} for {{product_name}}. Entry: {{entry_number}}.`,
    }],
    redemption_completed: [{
        id: 'rc_sms_1',
        name: 'SMS Redemption',
        channel: 'sms',
        body: `[Serapod2U] Redemption: {{consumer_name}} redeemed {{reward_name}} using {{points_used}} pts. Balance: {{remaining_points}}.`,
    }],
    user_created: [{
        id: 'uc_sms_1',
        name: 'SMS User Created',
        channel: 'sms',
        body: `[Serapod2U] New user created: {{user_name}} ({{user_email}}) with role {{user_role}}.`,
    }],
    user_created_shop: [{
        id: 'ucs_sms_1',
        name: 'SMS Shop Created',
        channel: 'sms',
        body: `[Serapod2U] New shop created: {{shop_name}} ({{shop_branch}}). Created by {{creator_name}} at {{created_at}}.`,
    }],
    user_activated: [{
        id: 'ua_sms_1',
        name: 'SMS User Activated',
        channel: 'sms',
        body: `[Serapod2U] Account activated: {{user_name}} ({{user_email}}) is now active.`,
    }],
    user_deactivated: [{
        id: 'ud_sms_1',
        name: 'SMS User Deactivated',
        channel: 'sms',
        body: `[Serapod2U] Account deactivated: {{user_name}} ({{user_email}}).`,
    }],
    password_changed: [{
        id: 'pc_sms_1',
        name: 'SMS Password Changed',
        channel: 'sms',
        body: `[Serapod2U] Password changed for {{user_email}} at {{changed_at}}. Not you? Contact admin immediately.`,
    }],
    password_reset_request: [{
        id: 'prr_sms_1',
        name: 'SMS Password Reset Request',
        channel: 'sms',
        body: `[Serapod2U] Password reset requested for {{user_email}} at {{requested_at}}.`,
    }],
    password_reset_otp: [{
        id: 'pro_sms_1',
        name: 'SMS Password Reset OTP',
        channel: 'sms',
        body: `[Serapod2U] Password reset code: {{verification_code}}. Expires in {{otp_expiry_minutes}} minutes.`,
    }],
    registration_otp: [{
        id: 'reg_otp_sms_1',
        name: 'SMS Registration OTP',
        description: 'One-time SMS code when a consumer creates an account',
        channel: 'sms',
        body: `[Serapod2U] Registration code: {{verification_code}}. Expires in {{otp_expiry_minutes}} minutes.`,
    }],
    delete_user_otp: [{
        id: 'delete_user_otp_sms_1',
        name: 'User Deletion OTP — SMS',
        channel: 'sms',
        body: `[Serapod UserDeletion OTP]:{{verification_code}}\nUser: {{target_user_name}}\nExpires in {{otp_expiry_minutes}} minutes.`,
    }],
    login_suspicious: [{
        id: 'sl_sms_1',
        name: 'SMS Suspicious Login',
        channel: 'sms',
        body: `[Serapod2U] ALERT: Suspicious login for {{user_email}} from {{ip_address}} at {{login_time}}. Not you? Change password now.`,
    }],
    po_created: [{
        id: 'poc_sms_1',
        name: 'SMS PO Created',
        channel: 'sms',
        body: `[Serapod2U] PO #{{doc_no}} created for Order #{{order_no}}. Amount: RM {{amount}}. Please acknowledge to proceed.`,
    }],
    po_acknowledged: [{
        id: 'poa_sms_1',
        name: 'SMS PO Acknowledged',
        channel: 'sms',
        body: `[Serapod2U] PO #{{doc_no}} acknowledged. Deposit Invoice #{{invoice_no}} generated. Amount: RM {{deposit_amount}} (30%).`,
    }],
    invoice_created: [{
        id: 'inv_sms_1',
        name: 'SMS Invoice Created',
        channel: 'sms',
        body: `[Serapod2U] Invoice #{{doc_no}} ready. Order #{{order_no}}. Deposit 30%: RM {{deposit_amount}}. Please review.`,
    }],
    invoice_acknowledged: [{
        id: 'inva_sms_1',
        name: 'SMS Invoice Acknowledged',
        channel: 'sms',
        body: `[Serapod2U] Invoice #{{doc_no}} acknowledged by {{acknowledged_by}}. Payment proof uploaded. Please verify.`,
    }],
    balance_request_created: [{
        id: 'brc_sms_1',
        name: 'SMS Balance Request',
        channel: 'sms',
        body: `[Serapod2U] Balance request #{{doc_no}} for Order #{{order_no}}. Due: RM {{balance_amount}} (70%). Manufacturing complete.`,
    }],
    payment_received: [{
        id: 'prcv_sms_1',
        name: 'SMS Payment Received',
        channel: 'sms',
        body: `[Serapod2U] Payment #{{doc_no}} received. Order #{{order_no}}. Amount: RM {{amount}}. Receipt will be generated.`,
    }],
    balance_payment_received: [{
        id: 'bpr_sms_1',
        name: 'SMS Balance Payment',
        channel: 'sms',
        body: `[Serapod2U] Balance payment received: Order #{{order_no}}. Amount: RM {{balance_amount}} (70%). Ready for closing.`,
    }],
    receipt_issued: [{
        id: 'ri_sms_1',
        name: 'SMS Receipt Issued',
        channel: 'sms',
        body: `[Serapod2U] Receipt #{{doc_no}} issued. Order #{{order_no}}. Amount: RM {{amount}}. Workflow complete.`,
    }],
    return_draft_created: [{
        id: 'rt_draft_sms_1',
        name: 'SMS Return Draft',
        channel: 'sms',
        body: `[Serapod2U] Return {{return_no}} created for {{return_source_name}}. Warehouse: {{return_warehouse_name}}. Items: {{total_quantity}} pcs.`,
    }],
    return_submitted: [{
        id: 'rt_sub_sms_1',
        name: 'Return Submitted',
        channel: 'sms',
        body: `[Serapod2U] Your product return {{return_no}} has been submitted to {{return_warehouse_name}}.`,
    }],
    return_received: [{
        id: 'rt_rec_sms_1',
        name: 'Return Received',
        channel: 'sms',
        body: `[Serapod2U] Your product return {{return_no}} has been received by {{return_warehouse_name}}.`,
    }],
    return_processing: [{
        id: 'rt_proc_sms_1',
        name: 'Return Processing',
        channel: 'sms',
        body: `[Serapod2U] Your product return {{return_no}} is now being processed.`,
    }],
    return_completed: [{
        id: 'rt_done_sms_1',
        name: 'Return Completed',
        channel: 'sms',
        body: `[Serapod2U] Your product return {{return_no}} has been completed.`,
    }],
    system_sms_check: [{
        id: 'sms_check_1',
        name: 'SMS Delivery Check',
        description: 'Short test SMS to confirm the SMS provider is working',
        channel: 'sms',
        body: `Serapod2U SMS check. If you received this, Local Malaysian SMS is working.`,
    }],
    generic: [{
        id: 'gen_sms_1',
        name: 'Generic SMS',
        channel: 'sms',
        body: `[Serapod2U] Update: {{event_name}}. Ref: {{reference_id}}`,
    }],
}

export function getSmsTemplatesForEvent(eventCode: string): SmsTemplate[] {
    return smsTemplates[eventCode] || smsTemplates.generic || []
}

export function getSmsTemplateBody(eventCode: string): string {
    return getSmsTemplatesForEvent(eventCode)[0]?.body || ''
}
