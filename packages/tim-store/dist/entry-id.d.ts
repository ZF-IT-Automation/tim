/** First 6 chars of session id from write metadata, else `ns`. */
export declare function sessionShortFromMetadata(metadata?: Record<string, unknown>): string;
/** `{device}-{MMDD}-{session_short}-{ulid}` */
export declare function formatEntryId(options?: {
    metadata?: Record<string, unknown>;
    now?: Date;
    device?: string;
}): string;
//# sourceMappingURL=entry-id.d.ts.map