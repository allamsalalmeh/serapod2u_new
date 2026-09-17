import { STOCK_COUNT_EVENT_CODE } from '@/lib/inventory/stock-count-verification-errors'

export const SYSTEM_SMS_CHECK_EVENT = 'system_sms_check'
export const SYSTEM_SMS_CHECK_MESSAGE = 'Serapod2U SMS check. If you received this, Local Malaysian SMS is working.'
export const PASSWORD_RESET_OTP_EVENT = 'password_reset_otp'
export const REGISTRATION_OTP_EVENT = 'registration_otp'
export const DELETE_USER_OTP_EVENT = 'delete_user_otp'

export const REQUIRED_NOTIFICATION_TYPES = [
    {
        category: 'system', event_code: SYSTEM_SMS_CHECK_EVENT, event_name: 'SMS Delivery Check',
        event_description: 'Manual system event to send a test SMS through the Local Malaysian provider and the SMS monitor.',
        default_enabled: true, available_channels: ['sms'], is_system: true, sort_order: 1,
    },
    {
        category: 'Delete Organization Masterdata', event_code: 'delete_organization_verification_code', event_name: 'Delete Organization Verification Code',
        event_description: 'Controls delivery of the security code required before organization master data can be deleted.',
        default_enabled: true, available_channels: ['whatsapp', 'sms', 'email'], is_system: true, sort_order: 10,
    },
    {
        category: 'user', event_code: 'user_created', event_name: 'User Account Created',
        event_description: 'Notifies new user of account creation. SMS copy is edited in Notification Types templates.',
        default_enabled: true, available_channels: ['email', 'sms'], is_system: false, sort_order: 14,
    },
    {
        category: 'user', event_code: 'user_created_shop', event_name: 'User Create New Shop',
        event_description: 'Sent when a user successfully creates a new shop from the QR profile flow.',
        default_enabled: false, available_channels: ['whatsapp', 'sms', 'email'], is_system: false, sort_order: 15,
    },
    {
        category: 'order', event_code: 'qr_batch_generated', event_name: 'QR Batch Generated',
        event_description: 'Sent when all QR codes for an order batch have been generated and the Excel file is ready.',
        default_enabled: false, available_channels: ['whatsapp', 'sms', 'email'], is_system: false, sort_order: 60,
    },
    {
        category: 'order', event_code: 'manufacturer_scan_complete', event_name: 'Manufacture Completed His Order',
        event_description: 'Sent when the manufacturer completes the production process and the batch is ready for shipment.',
        default_enabled: false, available_channels: ['whatsapp', 'sms', 'email'], is_system: false, sort_order: 65,
    },
    {
        category: 'order', event_code: 'warehouse_received', event_name: 'Warehouse Receive Order',
        event_description: 'Sent when warehouse receiving is complete and inventory has been updated.',
        default_enabled: false, available_channels: ['whatsapp', 'sms', 'email'], is_system: false, sort_order: 70,
    },
    {
        category: 'inventory', event_code: STOCK_COUNT_EVENT_CODE, event_name: 'Stock Count Posting Verification',
        event_description: 'Sends a security code to authorized recipients before inventory adjustments can be posted.',
        default_enabled: false, available_channels: ['email'], is_system: true, sort_order: 40,
    },
    {
        category: 'security', event_code: REGISTRATION_OTP_EVENT, event_name: 'Registration OTP (Consumer)',
        event_description: 'Sends a one-time code by email or SMS when a consumer creates an account from Collect Points / loyalty signup. Message copy comes from Notification Types templates.',
        default_enabled: true, available_channels: ['email', 'sms'], is_system: true, sort_order: 24,
    },
    {
        category: 'security', event_code: PASSWORD_RESET_OTP_EVENT, event_name: 'Password Reset OTP (Consumer)',
        event_description: 'Sends a one-time code by email or SMS when a consumer resets password from Collect Points / loyalty or portal login. SMS copy comes from Notification Types templates.',
        default_enabled: true, available_channels: ['email', 'sms'], is_system: true, sort_order: 25,
    },
    {
        category: 'security', event_code: DELETE_USER_OTP_EVENT, event_name: 'User Deletion OTP',
        event_description: 'Verification code to organization contact when HQ removes or archives a user. Recipient: organization contact phone/email. Synchronous OTP (not outbox).',
        default_enabled: true, available_channels: ['whatsapp', 'sms', 'email'], is_system: true, sort_order: 26,
    },
] as const

export const STOCK_COUNT_NOTIFICATION_TYPE = REQUIRED_NOTIFICATION_TYPES.find((type) => type.event_code === STOCK_COUNT_EVENT_CODE)!
