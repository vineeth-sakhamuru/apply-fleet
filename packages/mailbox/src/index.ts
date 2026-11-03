export { aliasFor } from './alias.ts';
export {
  readInbox,
  imapTransport,
  imapTransportFromEnv,
  appPasswordFromEnv,
  type MailTransport,
  type RawMessage,
  type ParsedMessage,
} from './reader.ts';
export { extractVerifyLink } from './verify.ts';
