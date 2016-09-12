export declare function normalizePath(path: string): string;
export declare function normalizeUpdatedValue(path: string, val: any): [string, any];
export declare function leafPath(path: string): string;
export declare function parentPath(path: string): string;
/**
 * Given acpath = /a/b/c and parentpath = /a/ will return /a/b
 */
export declare function limitToChild(acpath: string, parentpath: string): string;
export declare function pathRegexp(path: string, subpath?: string): RegExp;
export declare function isEmpty(obj: any): boolean;
