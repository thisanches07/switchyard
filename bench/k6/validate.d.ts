// Types for validate.js (shared by the k6 scripts and the unit tests).
export type Headers = Record<string, string | string[] | undefined>;

export declare const EXPECTED_CONTENT: string;
export declare const BASE_HEADERS: string[];
export declare const SUCCESS_HEADERS: string[];
export declare const STREAM_HEADERS: string[];
export declare function header(headers: Headers, name: string): string | undefined;
export declare function missingHeaders(headers: Headers, names: string[]): string[];
export declare function checkChatCompletion(bodyText: string): string | null;
export declare function checkSseStream(bodyText: string): string | null;
export declare function checkErrorBody(bodyText: string): string | null;
export declare function checkRetryAfter(headers: Headers): string | null;
export declare function cacheStatus(headers: Headers): "hit" | "miss" | "absent" | "invalid";
