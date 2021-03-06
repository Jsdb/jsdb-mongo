import * as Mongo from 'mongodb';
export declare var VERSION: string;
export interface Socket {
    id: string;
    on(event: string, cb: (...args: any[]) => any): any;
    emit(event: string, ...args: any[]): any;
    removeListener(event: string, cb: (...args: any[]) => any): any;
    removeAllListeners(): void;
}
export declare class Broker {
    private id;
    private socket;
    private collectionDb;
    private oplogDb;
    private collection;
    private oplog;
    private auth;
    private collectionNs;
    private started;
    private closed;
    private startWait;
    private handlers;
    private subscriptions;
    private oplogMaxtime;
    private oplogStream;
    constructor($socket?: SocketIO.Server, collectionDb?: string, collectionName?: string, oplogDb?: string, collectionOptions?: any);
    setSocketServer(value: SocketIO.Server): this;
    setCollection(value: Mongo.Collection): this;
    setOplogDb(value: Mongo.Db): this;
    initCollection(collectionDb: string, collectionName: string, collectionOptions?: Mongo.MongoClientOptions): this;
    initOplog(oplogDb: string): this;
    setAuthService(value: AuthService): this;
    start(): Promise<any>;
    handle(sock: Socket, authData: AuthData): Handler;
    private hookOplog();
    register(handler: Handler): void;
    unregister(handler: Handler): void;
    subscribe(handler: Subscriber, path: string): void;
    unsubscribe(handler: Subscriber, path: string): void;
    broadcast(path: string, val: any): void;
    private broadcastDown(path, val, alreadySent);
    private broadcastUp(path, val, fullpath, alreadySent);
    private broadcastToHandlers(path, val, alreadySent, fullpath?);
    close(): Promise<any>;
    del(handler: Handler, paths: string[]): Promise<any>;
    merge(handler: Handler, path: string, val: any): Promise<any>;
    set(handler: Handler, path: string, val: any): Promise<any>;
    recursiveUnroll(path: string, val: any, writes?: any[], dels?: string[]): void;
    fetch(handler: Subscriber, path: string, extra?: any): Promise<any>;
    query(queryState: SimpleQueryState): void;
}
export interface SimpleQueryDef {
    /**
     * Internal id used to cache and handle queries
     */
    id?: string;
    path?: string;
    compareField?: string;
    equals?: any;
    valueIn?: any[];
    from?: string;
    to?: string;
    sortField?: string;
    limit?: number;
    limitLast?: boolean;
}
export interface Subscriber {
    id: string;
    closed: boolean;
    writeProg?: number;
    sendValue(path: string, val: any, prog: number, extra?: any): void;
}
export interface SimpleQueryEntry {
    path: string;
    value: string;
}
export declare class SimpleQueryState implements Subscriber {
    def: SimpleQueryDef;
    /**
     * path->sort value
     */
    invalues: SimpleQueryEntry[];
    handler: Handler;
    broker: Broker;
    closed: boolean;
    private forwarder;
    private _pathRegex;
    private fetchingCnt;
    private fetchEnded;
    constructor(handler: Handler, broker: Broker, def: SimpleQueryDef);
    id: string;
    pathRegex: RegExp;
    positionFor(val: string): number;
    /**
     * Start the query, subscribing where needed
     */
    start(): void;
    stop(): void;
    counted(num: number): void;
    found(path: string, data: any): boolean;
    exited(path: string, ind?: number): void;
    foundEnd(): void;
    checkEnd(): void;
    checkExit(path: string): void;
    sendValue(path: string, val: any, prog: number, extra?: any): void;
}
export interface AuthService {
    authenticate(socket: Socket, data: any): Promise<AuthData>;
}
export interface AuthData {
    filterRead(path: string, value: Object): Object;
    filterWrite(path: string, value: Object): Object;
}
export declare class NopAuthData implements AuthData {
    filterRead(path: string, value: Object): Object;
    filterWrite(path: string, value: Object): Object;
}
export declare type SimpleAuthRuleReturn = boolean | Object;
/**
 * Simple tree rule function.
 *
 * @param match the match resolved so far, matches are variables in the tree starting with '$'
 * @param userData the userData as contained in AuthData
 * @param value the value being sent, could be a partial value so don't rely on its completeness when evaluating your rule.
 */
export interface SimpleAuthRuleFunction {
    (match: any, userData: any, value: Object): SimpleAuthRuleReturn;
}
export declare class SimpleAuthRule {
    path: string;
    fnc: SimpleAuthRuleFunction;
    constructor(path: string, fnc: SimpleAuthRuleFunction);
}
export declare class SimpleAuthRules {
    private rules;
    constructor(...rules: SimpleAuthRule[]);
    addRule(rule: SimpleAuthRule): void;
    private normalize(path, value);
    private denormalize(path, normalized);
    filterValue(path: string, val: Object, userData: any): Object;
    private iterate(path, val, rules, userData, match);
    private subMatch(match, key, val);
}
export declare class SimpleAuthData implements AuthData {
    private userData;
    private readRules;
    private writeRules;
    constructor(userData: any, readRules: SimpleAuthRules, writeRules: SimpleAuthRules);
    filterRead(path: string, value: Object): Object;
    filterWrite(path: string, value: Object): Object;
}
export declare class Handler implements Subscriber {
    private socket;
    authData: AuthData;
    private broker;
    id: string;
    closed: boolean;
    private pathSubs;
    private queries;
    private ongoingReads;
    private ongoingWrite;
    private writeQueue;
    private readQueue;
    writeProg: number;
    constructor(socket: Socket, authData: AuthData, broker: Broker);
    private enqueueRead(fn);
    private enqueueWrite(fn);
    private dequeue();
    updateAuthData(data: AuthData): void;
    close(): void;
    subscribePath(path: string): string;
    unsubscribePath(path: string): string;
    subscribeQuery(def: SimpleQueryDef): string;
    unsubscribeQuery(id: string): string;
    ping(writeProg: number): number;
    set(path: string, val: any, prog: number, cb: Function): void;
    merge(path: string, val: any, prog: number, cb: Function): void;
    sendValue(path: string, val: any, prog: number, extra?: any): void;
    queryCount(queryId: string, num: number): void;
    queryFetchEnd(queryId: string): void;
    queryExit(path: string, queryId: string): void;
}
export declare class Recomposer {
    base: string;
    refs: {
        [index: string]: any;
    };
    constructor(base: string);
    add(obj: any): void;
    get(): any;
    private findOrCreateRefFor(path, obj);
}
export declare class LocalSocket {
    server: Socket;
    client: Socket;
    constructor();
}
