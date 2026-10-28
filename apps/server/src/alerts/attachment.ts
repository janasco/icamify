/**
 * A file attached to an alert: a snapshot JPEG today, anything the channel
 * accepts tomorrow. Structural, so SMTP, Telegram and tests agree without
 * sharing a class.
 */
export interface AlertAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}
